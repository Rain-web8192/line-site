import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  loginWithPassword,
  loginWithAuthToken,
  Client,
  SquareMessage,
} from "@evex/linejs";

// Cloudflare Worker 環境で使用する env の型
type Env = Record<string, unknown> & {
  LINE_D1?: unknown;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASS?: string;
  CONSENT_WEBHOOK_URL?: string;
  AGREE_WEBHOOK_URL?: string;
};

// D1 の最小形インターフェース
type D1Db = {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first?: () => Promise<unknown>;
      run?: () => Promise<unknown>;
    };
  };
};

// linejs の BaseStorage 互換に見せるための最小インターフェース
type BaseStorageLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  migrate(): Promise<void>;
};

// -----------------------------------------------------------------------------
// グローバル状態
// -----------------------------------------------------------------------------

const clientCache = new Map<string, Client>();

// 共通 CORS ヘッダー (cors() ミドルウェアでも付与されるが JSON レスポンスにも同一値を付与)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// セッション管理用ヘルパー関数群
/**
 * セッション ID（UUID 相当）を生成
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * セッションを D1 に保存
 */
async function saveSession(
  db: unknown,
  sessionId: string,
  authToken: string,
  expiresInHours: number,
  refreshToken: string | null,
  userMid: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
  
  const d1 = db as unknown as D1Db;
  const stmt = d1.prepare(
    "INSERT INTO sessions (session_id, auth_token, refresh_token, user_mid, created_at, last_accessed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_accessed_at = ?, expires_at = ?",
  );
  const bound = stmt.bind(
    sessionId,
    authToken,
    refreshToken,
    userMid,
    now,
    now,
    expiresAt,
    now,
    expiresAt,
  );
  const runFn = bound.run;
  if (runFn) await runFn();
}

/**
 * セッションから authToken を取得
 */
async function getSessionAuthToken(db: unknown, sessionId: string): Promise<string | null> {
  const d1 = db as unknown as D1Db;
  const stmt = d1.prepare(
    "SELECT auth_token, expires_at FROM sessions WHERE session_id = ? LIMIT 1",
  );
  const bound = stmt.bind(sessionId);
  const firstFn = bound.first;
  if (!firstFn) return null;
  
  const row = (await firstFn()) as unknown as {
    auth_token?: string;
    expires_at?: string;
  } | null;
  
  if (!row) return null;
  
  // 有効期限チェック
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    // 期限切れセッションを削除
    const delStmt = d1.prepare("DELETE FROM sessions WHERE session_id = ?");
    const delBound = delStmt.bind(sessionId);
    const delRunFn = delBound.run;
    if (delRunFn) await delRunFn();
    return null;
  }
  
  // last_accessed_at を更新
  const updateStmt = d1.prepare("UPDATE sessions SET last_accessed_at = ? WHERE session_id = ?");
  const updateBound = updateStmt.bind(new Date().toISOString(), sessionId);
  const updateRunFn = updateBound.run;
  if (updateRunFn) await updateRunFn().catch(() => {
    // 更新失敗は無視
  });
  
  return row.auth_token ?? null;
}

// -----------------------------------------------------------------------------
// ユーティリティ関数群
// -----------------------------------------------------------------------------

/** User‑Agent 文字列を簡易解析してブラウザ/OS/デバイス種別を返す */
function parseUserAgent(userAgent: string) {
  const browser = userAgent.includes("Chrome")
    ? "Chrome"
    : userAgent.includes("Firefox")
    ? "Firefox"
    : userAgent.includes("Safari")
    ? "Safari"
    : "Unknown";

  const os = userAgent.includes("Windows")
    ? "Windows"
    : userAgent.includes("Mac")
    ? "macOS"
    : userAgent.includes("Linux")
    ? "Linux"
    : userAgent.includes("Android")
    ? "Android"
    : userAgent.includes("iOS")
    ? "iOS"
    : "Unknown";

  const device = userAgent.includes("Mobile") ? "Mobile" : "Desktop";
  return { browser, os, device } as const;
}

/**
 * events から squareMemberMid (pid) を抽出
 */
interface MaybeSquareMessageContent {
  from?: string;
  contentType?: string | number;
}

interface MaybeSquarePayload {
  receiveMessage?: { squareMessage?: { message?: MaybeSquareMessageContent } };
  sendMessage?: { squareMessage?: { message?: MaybeSquareMessageContent } };
  notifiedUpdateSquareMemberProfile?: { squareMemberMid?: string };
  notifiedCreateSquareMember?: { squareMember?: { squareMemberMid?: string } };
}

function extractPidsFromEvents(events: unknown[]): string[] {
  const evts = Array.isArray(events) ? events : [];
  console.debug("[DEBUG] extractPidsFromEvents 開始, events数:", evts.length);
  const pids = new Set<string>();

  for (const event of evts) {
    const evt = event as Record<string, unknown>;
    const payload = (evt.payload as MaybeSquarePayload) ?? {};
    const squareMessage =
      payload.receiveMessage?.squareMessage ?? payload.sendMessage?.squareMessage;
    const msg = (squareMessage as { message?: MaybeSquareMessageContent } | undefined)?.message;
    if (msg?.from) pids.add(msg.from);

    if (evt.type === "NOTIFIED_UPDATE_SQUARE_MEMBER_PROFILE") {
      const memberMid = payload.notifiedUpdateSquareMemberProfile?.squareMemberMid;
      if (memberMid) pids.add(memberMid);
    }

    const createdMid = payload.notifiedCreateSquareMember?.squareMember?.squareMemberMid;
    if (createdMid) pids.add(createdMid);
  }

  const result = [...pids];
  console.debug("[DEBUG] 抽出されたpids:", result);
  return result;
}

/** 指定した SquareChat のメンバープロフィールをまとめて取得 */
async function getSquareMemberProfiles(
  client: Client,
  pids: string[],
  squareChatMid: string,
) {
  console.debug("[DEBUG] getSquareMemberProfiles 開始");
  const map = new Map<
    string,
    { displayName: string; pictureStatus: string; revision: number }
  >();

  try {
    const squareChat = await client.getSquareChat(squareChatMid);
    const members = await squareChat.getMembers();
    console.debug("[DEBUG] チャットメンバー取得結果:", members.length);

    for (const member of members) {
      if (pids.includes(member.squareMemberMid)) {
        map.set(member.squareMemberMid, {
          displayName: member.displayName,
          pictureStatus: member.profileImageObsHash,
          revision: member.revision as number,
        });
      }
    }
    console.debug("[DEBUG] 抽出されたプロフィール数:", map.size);
  } catch (err) {
    console.error("[ERROR] チャットメンバー取得失敗", err);
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }
  return map;
}

// -----------------------------------------------------------------------------
// D1Storage: Cloudflare D1 を簡易的に使うためのストレージ実装
// 必要: Worker のバインディングに D1 を `LINE_D1` という名前で追加
// テーブル: kv (key TEXT PRIMARY KEY, value TEXT)
// -----------------------------------------------------------------------------
class D1Storage {
  db: unknown;
  prefix: string;
  constructor(db: unknown, prefix = "linejs:") {
    this.db = db;
    this.prefix = prefix;
  }

  private realKey(key: string) {
    return `${this.prefix}${key}`;
  }

  async get(key: string) {
    const rk = this.realKey(key);
    const db = this.db as unknown as D1Db;
    const stmt = db.prepare("SELECT value FROM kv WHERE key = ?");
    const bound = stmt.bind(rk);
    const firstFn = bound.first;
    const row = firstFn ? (await firstFn()) : null;
  return (row as unknown as { value?: string })?.value ?? null;
  }

  async set(key: string, value: string) {
    const rk = this.realKey(key);
    const db = this.db as unknown as D1Db;
    const stmt = db.prepare(
      "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const bound = stmt.bind(rk, value);
    const runFn = bound.run;
    if (runFn) await runFn();
  }

  async remove(key: string) {
    const rk = this.realKey(key);
    const db = this.db as unknown as D1Db;
    const stmt = db.prepare("DELETE FROM kv WHERE key = ?");
    const bound = stmt.bind(rk);
    const runFn = bound.run;
    if (runFn) await runFn();
  }

  // BaseStorage の互換メソッド（最小実装）
  async delete(key: string) {
    await this.remove(key);
  }

  async clear() {
    const db = this.db as unknown as D1Db;
    // caution: 大量のデータがある場合は注意
    const stmt = db.prepare("DELETE FROM kv");
    const runFn = stmt.bind().run;
    if (runFn) await runFn();
  }

  migrate() {
    // noop for now
    return;
  }
}

/**
 * authToken/refreshToken をキーに Client をキャッシュし、なければ生成
 */
async function getOrCreateClient(
  authToken: string,
  refreshToken: string | undefined,
  env: Env,
): Promise<Client> {
  const cacheKey = `${authToken}_${refreshToken ?? "no-refresh"}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey)!;

  const d1 = env.LINE_D1;
  const storage = d1 ? new D1Storage(d1) : null;
  if (!storage) console.warn("[WARN] LINE_D1 binding not found; encryption keys won't be persisted");

  if (refreshToken && storage) {
    console.info("[INFO] refreshToken を受信: D1 に保存");
    await storage.set("refreshToken", String(refreshToken));
  }

  try {
    const client = await loginWithAuthToken(authToken, {
      device: "DESKTOPWIN",
      // @ts-ignore: pass storage implementation at runtime
      storage: storage as unknown,
    });

    client.base.on("update:authtoken", (newToken) => {
      console.info("[INFO] authToken 更新", newToken);
      clientCache.delete(cacheKey);
      clientCache.set(`${newToken}_${refreshToken ?? "no-refresh"}`, client);
    });
    // @ts-expect-error 型定義に存在しないが実際は発火する
    client.base.on("update:refreshToken", async (newRT: string) => {
      console.info("[INFO] refreshToken 更新", newRT);
      if (storage) await storage.set("refreshToken", newRT);
    });

    clientCache.set(cacheKey, client);
    return client;
  } catch (err) {
    console.error("[ERROR] ログイン失敗", err);
    throw err;
  }
}

  // 連投検知回避
  function processText(text: string): string {
    const variationSelectors = Array.from({ length: 16 }, (_, i) =>
      String.fromCharCode(0xFE00 + i)
    );
    const insertCount = Math.ceil(text.length / 20);
    const positions = new Set<number>();

    while (positions.size < insertCount) {
      const pos = Math.floor(Math.random() * (text.length + 1));
      positions.add(pos);
    }

    const chars = text.split("");
    Array.from(positions)
      .sort((a, b) => b - a)
      .forEach(pos => {
        const randVS =
          variationSelectors[Math.floor(Math.random() * variationSelectors.length)];
        chars.splice(pos, 0, randVS);
      });

    return chars.join("");
  }

// -----------------------------------------------------------------------------
// Hono アプリケーション定義
// -----------------------------------------------------------------------------

const app = new Hono();

// === ミドルウェア ===
app.use("/*", cors());

// Basic認証を全ルートに適用
// Basic auth の簡易実装 (Workers の環境変数を参照)
app.use("/*", async (c, next) => {
  const user = (c.env as Env).BASIC_AUTH_USER ?? "admin";
  const pass = (c.env as Env).BASIC_AUTH_PASS ?? "secret";
    const auth = c.req.header("authorization");
    if (!auth || !auth.startsWith("Basic ")) return c.text("Unauthorized", 401);
    const b = atob(auth.replace(/^Basic /, ""));
    const [u, p] = b.split(":", 2);
  if (u !== user || p !== pass) return c.text("Unauthorized", 401);
  await next();
});

// Workers ではフロントエンドを別途配信する想定。簡易なトップレスポンスを用意。
app.get("/", (c) => c.text("LINE backend (Cloudflare Workers)"));

// -----------------------------------------------------------------------------
// API: /api/terms-agreement   (POST)
// -----------------------------------------------------------------------------
app.post("/api/terms-agreement", async (c) => {
  try {
    const body = await c.req.json();

    const userAgent = c.req.header("user-agent") ?? "unknown";
    const deviceInfo = parseUserAgent(userAgent);

  // Discord Webhook 送信
  const webhookUrl = (c.env as Env).CONSENT_WEBHOOK_URL as string | undefined;
    if (webhookUrl) {
      const discordMessage = {
        content: "利用規約への同意が記録されました",
        embeds: [
          {
            title: "利用規約同意ログ",
            color: 0x00b900,
            fields: [
              { name: "タイムスタンプ", value: new Date().toISOString(), inline: true },
              { name: "ブラウザ", value: `${deviceInfo.browser} (${deviceInfo.os})`, inline: true },
              { name: "デバイス", value: deviceInfo.device, inline: true },
              { name: "利用規約バージョン", value: "1.0", inline: true },
              {
                name: "同意項目",
                value: `18歳以上: ${body.ageConfirmed ? "✅" : "❌"}\n利用規約: ${body.termsAgreed ? "✅" : "❌"}`,
                inline: false,
              },
            ],
            footer: { text: "LINE Chat Application" },
            timestamp: body.timestamp,
          },
        ],
      };

      try {
    const res = await fetch(webhookUrl as string, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "LINE-Terms-Agreement-Bot/1.0",
          },
          body: JSON.stringify(discordMessage),
        });
        if (!res.ok) {
          console.error("[ERROR] Webhook 送信失敗", res.status, await res.text());
        } else console.info("[INFO] Discord Webhook 送信成功");
      } catch (err) {
        console.error("[ERROR] Webhook エラー", err);
      }
    }

    return c.json(
      { success: true, message: "利用規約への同意を記録しました" },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error("[ERROR] 利用規約同意 API", err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      400,
      corsHeaders,
    );
  }
});

// -----------------------------------------------------------------------------
// API: /api/login/password   (POST)
// -----------------------------------------------------------------------------
app.post("/api/login/password", async (c) => {
  try {
    const body = await c.req.json();
    const email = body.email as string;
    const password = body.password as string;
    const pincode = body.pincode as string | undefined;

    const d1 = (c.env as Env).LINE_D1;
    if (!d1) {
      return c.json(
        { success: false, error: "D1 database not configured" },
        500,
        corsHeaders,
      );
    }

    const storage = new D1Storage(d1);
    const client = await loginWithPassword(
      {
        email,
        password,
        pincode,
        onPincodeRequest(pin) {
          console.log("PINコード:", pin);
        },
      },
      { device: "DESKTOPWIN", storage: storage as unknown as BaseStorageLike },
    );

    // 認証成功。セッション ID を生成して D1 に保存
    const sessionId = generateSessionId();
    const authTokenVal = client.base.authToken;
    if (typeof authTokenVal !== "string") {
      return c.json(
        { success: false, error: "authToken not found" },
        400,
        corsHeaders,
      );
    }
    const authToken = authTokenVal;
    let refreshToken: string | null = null;
    const refreshTokenVal = await client.base.storage.get("refreshToken");
    if (typeof refreshTokenVal === "string") {
      refreshToken = refreshTokenVal;
    }
    let userMid: string | null = null;
    const userMidVal = (client.base.profile as unknown as { mid?: string })?.mid;
    if (typeof userMidVal === "string") {
      userMid = userMidVal;
    }

    await saveSession(
      d1,
      sessionId,
      authToken,
      24,
      refreshToken,
      userMid,
    );

    console.info("[INFO] ログインセッション作成:", sessionId);

    return c.json(
      {
        success: true,
        sessionId,
        message: "ログインに成功しました",
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error("[ERROR] ログイン失敗:", err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      400,
      corsHeaders,
    );
  }
});

// -----------------------------------------------------------------------------
// 総合 API (旧: POST *) – action に応じた処理
// -----------------------------------------------------------------------------
app.post("*", async (c) => {
  // 上記エンドポイントで処理済みの場合はスキップ
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Unknown API path" }, 404, corsHeaders);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON ボディが必要です" }, 400, corsHeaders);
  }
  const b = (body as Record<string, unknown> | null) ?? {};
  const sessionId: string | undefined = b.sessionId as string | undefined;
  const action = b.action as string | undefined;
  const text = (b.text as string | undefined) ?? "デフォルトメッセージ";
  const squareChatMid = (b.squareChatMid as string | undefined) ?? "";
  const sendcount = Number(b.sendcount ?? b.sendCount ?? 1) || 1;
  
  // sessionId は必須（トークン直接渡しは廃止）
  if (!sessionId || !action) {
    return c.json(
      { error: "sessionId と action は必須です（トークン直接渡しは廃止されました）" },
      400,
      corsHeaders,
    );
  }

  try {
    const d1 = (c.env as Env).LINE_D1;
    if (!d1) {
      return c.json(
        { error: "D1 database not configured" },
        500,
        corsHeaders,
      );
    }

    // sessionId から authToken を取得
    const authToken = await getSessionAuthToken(d1, sessionId);
    if (!authToken) {
      return c.json(
        { error: "セッションが無効です。再度ログインしてください。" },
        401,
        corsHeaders,
      );
    }

    const client = await getOrCreateClient(authToken, undefined, c.env as Env);

    // ----------------------------
    // action = "squares"
    // ----------------------------
    if (action === "squares") {
      const chats = await client.fetchJoinedSquareChats();

      // セッション使用ログを Discord Webhook へ通知
      const profile = client.base.profile;
      const userInfo = `mid:${profile?.mid ?? "unknown"}`;

      const webhookUrl = (c.env as Env).AGREE_WEBHOOK_URL as string | undefined;
      if (webhookUrl) {
        const ua = c.req.header("user-agent") ?? "unknown";
        const dev = parseUserAgent(ua);
        const loginEmbed = {
          content: "セッションアクセスが記録されました",
          embeds: [
            {
              title: "セッションアクセスログ",
              color: 0x0099ff,
              fields: [
                { name: "タイムスタンプ", value: new Date().toISOString(), inline: true },
                { name: "ユーザー情報", value: userInfo, inline: true },
                { name: "ブラウザ", value: `${dev.browser} (${dev.os})`, inline: true },
                { name: "デバイス", value: dev.device, inline: true },
              ],
              footer: { text: "LINE Chat Application - Session Access" },
              timestamp: new Date().toISOString(),
            },
          ],
        };
        try {
          const res = await fetch(webhookUrl as string, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "LINE-Session-Bot/1.0",
            },
            body: JSON.stringify(loginEmbed),
          });
          if (!res.ok) console.error("[ERROR] Login Webhook 失敗", await res.text());
        } catch (err) {
          console.error("[ERROR] Login Webhook", err);
        }
      }

      const result = await Promise.all(
        chats.map(async (c) => {
          try {
            const detail = await client.base.square.getSquareChat({
              squareChatMid: String(c.raw.squareChatMid),
            });
            return {
              squareChatMid: String(c.raw.squareChatMid),
              name: c.raw.name,
              chat: detail.squareChat,
              squareStatus: detail.squareChatStatus?.otherStatus
                ? { memberCount: detail.squareChatStatus.otherStatus.memberCount }
                : null,
              chatImageObsHash: detail.squareChat.chatImageObsHash,
            };
          } catch (err) {
            console.error("[ERROR] チャット詳細取得失敗", err);
            return {
              squareChatMid: String(c.raw.squareChatMid),
              name: c.raw.name,
              chat: c.raw,
              squareStatus: null,
              chatImageObsHash: c.raw.chatImageObsHash,
            };
          }
        }),
      );

      return c.json(
        {
          result,
          success: true,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "send"
    // ----------------------------
    // action = "send"
    // ----------------------------
    if (action === "send") {
      await client.base.square.sendMessage({ squareChatMid, text });
      return c.json(
        {
          message: "メッセージを送信しました",
          success: true,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "sends"
    // ----------------------------
    if (action === "sends") {
      for (let i = 0; i < sendcount; i++) {
        const processedText = processText(text);
        await client.base.square.sendMessage({ squareChatMid, text: processedText });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return c.json(
        {
          message: `${sendcount} 回メッセージを送信しました`,
          success: true,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "replyToMessage"
    // ----------------------------
    if (action === "replyToMessage") {
      const relatedMessageId = b.relatedMessageId as string | undefined;
      if (!relatedMessageId) {
        return c.json({ error: "relatedMessageId は必須です" }, 400, corsHeaders);
      }
      await client.base.square.sendMessage({ squareChatMid, text, relatedMessageId });
      return c.json(
        {
          message: "リプライメッセージを送信しました",
          success: true,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "messages"
    // ----------------------------
    if (action === "messages") {
      console.debug("[DEBUG] messages アクション開始");
      const res = await client.base.square.fetchSquareChatEvents({
        squareChatMid,
        limit: 150,
      });
      console.debug("[DEBUG] events 取得完了", res.events?.length || 0);

      const pids = extractPidsFromEvents(res.events || []);
      const profiles = await getSquareMemberProfiles(client, pids, squareChatMid);

      const eventsWithImage = await Promise.all(
        (res.events || []).map(async (event) => {
          const sMsg =
            event.payload?.receiveMessage?.squareMessage ??
            event.payload?.sendMessage?.squareMessage;
          const msg = sMsg?.message;

          if (
            msg &&
            ["IMAGE", "VIDEO", "AUDIO", "FILE"].includes(String(msg.contentType))
          ) {
            try {
              const sqMsg = await SquareMessage.fromRawTalk(sMsg, client);
              const fileData = await sqMsg.getData();
              const dataURI = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(fileData);
              });
              return { ...event, imageData: dataURI, isImage: true };
            } catch (err) {
              console.error("[DEBUG] 画像取得エラー", err);
              return { ...event, isImage: false, imageError: err instanceof Error ? err.message : String(err) };
            }
          }
          return event;
        }),
      );

      // BigInt -> string 変換
      const replacer = (_key: string, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value;
      const responseObj = {
        events: eventsWithImage,
        profiles: Object.fromEntries(profiles),
        success: true,
      };
      const jsonStr = JSON.stringify(responseObj, replacer);
      return new Response(jsonStr, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ----------------------------
    // action = "getProfile"
    // ----------------------------
    if (action === "getProfile") {
      const pid = b.pid as string | undefined;
      if (!pid) return c.json({ error: "pid は必須" }, 400, corsHeaders);
      if (!squareChatMid) return c.json({ error: "squareChatMid は必須" }, 400, corsHeaders);
      try {
        const squareChat = await client.getSquareChat(squareChatMid);
        const member = (await squareChat.getMembers()).find((m) =>
          m.squareMemberMid === pid
        );
        if (member) {
          return c.json(
            {
              success: true,
              profile: {
                displayName: member.displayName,
                pictureStatus: member.profileImageObsHash,
                revision: member.revision,
              },
            },
            200,
            corsHeaders,
          );
        }
        return c.json({ success: false, error: "メンバーが見つかりません" }, 404, corsHeaders);
      } catch (err) {
        console.error("[ERROR] プロフィール取得", err);
        return c.json(
          { success: false, error: err instanceof Error ? err.message : String(err) },
          500,
          corsHeaders,
        );
      }
    }

    // ----------------------------
    // 未定義 action
    // ----------------------------
    return c.json({ error: "Unknown action" }, 400, corsHeaders);
  } catch (err) {
    console.error("[ERROR] 総合 API", err);
    if (
      err instanceof Error &&
      (
        err.message?.includes("MUST_REFRESH_V3_TOKEN") ||
        err.message?.includes("AUTHENTICATION_FAILED") ||
        err.message?.includes("INVALID_TOKEN")
      )
    ) {
      return c.json(
        {
          error: "認証エラー",
          message: "セッションが無効です。再度ログインしてください。",
          needsReauth: true,
        },
        401,
        corsHeaders,
      );
    }
    return c.json(
      {
        error: "処理エラー",
        message: "処理中にエラーが発生しました",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
      corsHeaders,
    );
  }
});

// -----------------------------------------------------------------------------
// アプリ起動
// -----------------------------------------------------------------------------
// Workers エクスポート
console.log("[INFO] LINE 操作サーバー (Worker) 準備完了");
export default {
  fetch(req: Request, env: Env, ctx: unknown) {
    // Hono の fetch に env を渡すため、c.env で参照可能になります
    return app.fetch(req, { env, ctx } as unknown as Record<string, unknown>);
  },
};
