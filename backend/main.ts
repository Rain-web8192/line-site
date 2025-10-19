import { Hono, Context } from "hono";
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
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<{ success: boolean; meta?: unknown }>;
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
 * ユーザーをD1に保存または取得
 */
async function getOrCreateUser(
  db: unknown,
  email: string,
  userMid: string | null,
): Promise<number | null> {
  // D1がない場合（開発環境）はダミーIDを返す
  if (!db) {
    return 1;
  }

  const d1 = db as unknown as D1Db;
  const now = new Date().toISOString();

  // ユーザーが存在するか確認
  const existingUser = await d1
    .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ id?: number }>();
  
  if (existingUser?.id) {
    // 最終ログイン時刻を更新
    await d1
      .prepare("UPDATE users SET last_login_at = ?, user_mid = ? WHERE id = ?")
      .bind(now, userMid, existingUser.id)
      .run();
    return existingUser.id;
  }

  // 新規ユーザーを作成
  await d1
    .prepare("INSERT INTO users (email, user_mid, created_at, last_login_at) VALUES (?, ?, ?, ?)")
    .bind(email, userMid, now, now)
    .run();
  
  // D1のINSERT結果から新しいIDを取得
  const newUser = await d1
    .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(email)
    .first<{ id?: number }>();
  
  return newUser?.id ?? null;
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
  userId: number | null,
): Promise<void> {
  // D1がない場合（開発環境）は何もしない
  if (!db) {
    console.log("[DEBUG] saveSession: D1 is not available");
    return;
  }

  console.log("[DEBUG] saveSession: Saving session to D1:", sessionId);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
  
  const d1 = db as unknown as D1Db;
  await d1
    .prepare(
      "INSERT INTO sessions (session_id, user_id, auth_token, refresh_token, user_mid, created_at, last_accessed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_accessed_at = ?, expires_at = ?",
    )
    .bind(
      sessionId,
      userId,
      authToken,
      refreshToken,
      userMid,
      now,
      now,
      expiresAt,
      now,
      expiresAt,
    )
    .run();
}

/**
 * セッションから authToken を取得
 */
async function getSessionAuthToken(db: unknown, sessionId: string): Promise<string | null> {
  // D1がない場合（開発環境）は空のトークンを返す
  if (!db) {
    console.log("[DEBUG] getSessionAuthToken: D1 is not available");
    return null;
  }

  console.log("[DEBUG] getSessionAuthToken: Fetching session from D1:", sessionId);
  // D1から取得
  const d1 = db as unknown as D1Db;
  const row = await d1
    .prepare("SELECT auth_token, expires_at FROM sessions WHERE session_id = ? LIMIT 1")
    .bind(sessionId)
    .first<{ auth_token?: string; expires_at?: string }>();
    
  if (!row) return null;
  
  // 有効期限チェック
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    // 期限切れセッションを削除
    await d1
      .prepare("DELETE FROM sessions WHERE session_id = ?")
      .bind(sessionId)
      .run();
    return null;
  }
  
  // last_accessed_at を更新
  await d1
    .prepare("UPDATE sessions SET last_accessed_at = ? WHERE session_id = ?")
    .bind(new Date().toISOString(), sessionId)
    .run()
    .catch(() => {
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
// MemoryStorage: 開発用の簡易メモリストレージ実装
// D1 がない場合はこれを使用
// -----------------------------------------------------------------------------
class MemoryStorage {
  private data: Map<string, string> = new Map();
  prefix: string;

  constructor(prefix = "linejs:") {
    this.prefix = prefix;
  }

  private realKey(key: string) {
    return `${this.prefix}${key}`;
  }

  async get(key: string) {
    return this.data.get(this.realKey(key)) ?? null;
  }

  async set(key: string, value: string) {
    this.data.set(this.realKey(key), value);
  }

  async remove(key: string) {
    this.data.delete(this.realKey(key));
  }

  async delete(key: string) {
    await this.remove(key);
  }

  async clear() {
    this.data.clear();
  }

  migrate() {
    // noop
    return;
  }
}

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
    const row = await db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .bind(rk)
      .first<{ value?: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string) {
    const rk = this.realKey(key);
    const db = this.db as unknown as D1Db;
    await db
      .prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(rk, value)
      .run();
  }

  async remove(key: string) {
    const rk = this.realKey(key);
    const db = this.db as unknown as D1Db;
    await db
      .prepare("DELETE FROM kv WHERE key = ?")
      .bind(rk)
      .run();
  }

  // BaseStorage の互換メソッド（最小実装）
  async delete(key: string) {
    await this.remove(key);
  }

  async clear() {
    const db = this.db as unknown as D1Db;
    // caution: 大量のデータがある場合は注意
    await db
      .prepare("DELETE FROM kv")
      .bind()
      .run();
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

const app = new Hono<{ Bindings: Env }>();

// === ミドルウェア ===
app.use("/*", cors({
  origin: ["*"],
  allowHeaders: ["Content-Type"],
  credentials: false,
}));

// セッション認証ミドルウェア（公開エンドポイントは除外）
app.use("/*", async (c, next) => {
  // 公開エンドポイント（認証不要）
  const publicPaths = [
    "/api/terms-agreement",
    "/api/login/password",
  ];
  
  // GETリクエストやトップページも認証不要
  if (c.req.method === "GET" || publicPaths.includes(c.req.path)) {
    await next();
    return;
  }
  
  // POSTリクエストの場合、sessionIdの検証を行う（総合APIで実施）
  // ここでは認証チェックをスキップし、各エンドポイントで個別に検証
  await next();
});

// Workers ではフロントエンドを別途配信する想定。簡易なトップレスポンスを用意。
app.get("/", (c) => c.text("LINE backend (Cloudflare Workers)"));

// =============================================================================
// 総合 API: POST / と POST (/api以下でない他のパス)
// =============================================================================
const handleTotalApi = async (c: Context<{ Bindings: Env }>) => {
  console.log("[DEBUG] handleTotalApi called, path:", c.req.path, "method:", c.req.method);
  
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON ボディが必要です" }, 400, corsHeaders);
  }
  const b = (body as Record<string, unknown> | null) ?? {};
  
  console.log("[DEBUG] Request body:", JSON.stringify(b));
  
  // CookieからセッションIDを取得
  const cookieHeader = c.req.header('Cookie') || '';
  const sessionIdMatch = cookieHeader.match(/sessionId=([^;]+)/);
  const sessionId: string | undefined = sessionIdMatch ? sessionIdMatch[1] : (b.sessionId as string | undefined);
  
  console.log("[DEBUG] SessionId from cookie:", sessionIdMatch ? sessionIdMatch[1] : "none");
  console.log("[DEBUG] SessionId from body:", b.sessionId);
  console.log("[DEBUG] Final sessionId:", sessionId);
  
  const action = b.action as string | undefined;
  const text = (b.text as string | undefined) ?? "デフォルトメッセージ";
  const squareChatMid = (b.squareChatMid as string | undefined) ?? "";
  const sendcount = Number(b.sendcount ?? b.sendCount ?? 1) || 1;
  
  // sessionId と action は必須
  if (!sessionId || !action) {
    return c.json(
      { error: "sessionId と action は必須です" },
      400,
      corsHeaders,
    );
  }

  try {
    const d1 = (c.env as Env).LINE_D1;
    console.log("[DEBUG] handleTotalApi D1 available:", !!d1);

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
      // OpenChatを取得
      const squareChats = await client.fetchJoinedSquareChats();

      // 個人チャットとグループチャットを取得
      const personalChats: unknown[] = [];
      const groupChats: unknown[] = [];

      try {
        const base = client.base as unknown as Record<string, unknown>;
        const talkService = base.talk as Record<string, unknown> | undefined;
        const relationService = base.relation as Record<string, unknown> | undefined;

        if (talkService && typeof (talkService as { getAllContactIds?: unknown }).getAllContactIds === "function") {
          const midsResult = await (talkService as {
            getAllContactIds: (options: { syncReason?: string }) => Promise<unknown>;
          }).getAllContactIds({ syncReason: "INTERNAL" });

          const midsCandidate = Array.isArray(midsResult)
            ? midsResult
            : Array.isArray((midsResult as { contactIds?: unknown }).contactIds)
            ? (midsResult as { contactIds: unknown[] }).contactIds
            : [];

          const mids = midsCandidate.filter((mid): mid is string => typeof mid === "string");

          if (mids.length > 0) {
            if (typeof (talkService as { getContacts?: unknown }).getContacts === "function") {
              const contacts = await (talkService as {
                getContacts: (options: { mids: string[] }) => Promise<unknown>;
              }).getContacts({ mids });
              if (Array.isArray(contacts)) {
                personalChats.push(...contacts);
              }
            } else if (
              relationService &&
              typeof (relationService as { getContactsV3?: unknown }).getContactsV3 === "function"
            ) {
              const contactsRes = await (relationService as {
                getContactsV3: (options: { mids: string[] }) => Promise<{ responses?: unknown[] }>;
              }).getContactsV3({ mids });
              const responses = contactsRes?.responses;
              if (Array.isArray(responses)) {
                personalChats.push(...responses);
              }
            }
          }
        }

        if (typeof (client as { fetchJoinedChats?: () => Promise<unknown[]> }).fetchJoinedChats === "function") {
          const joinedChats = await client.fetchJoinedChats();
          if (Array.isArray(joinedChats)) {
            groupChats.push(...joinedChats);
          }
        }
      } catch (err) {
        console.error("[WARNING] 個人チャット/グループチャット取得に失敗", err);
      }

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

      // OpenChatの詳細情報を取得
      const squareResult = await Promise.all(
        squareChats.map(async (c) => {
          try {
            const detail = await client.base.square.getSquareChat({
              squareChatMid: String((c.raw as unknown as Record<string, unknown>).squareChatMid),
            });
            return {
              squareChatMid: String((c.raw as unknown as Record<string, unknown>).squareChatMid),
              name: (c.raw as unknown as Record<string, unknown>).name,
              chat: detail.squareChat,
              chatType: 'square',
              squareStatus: detail.squareChatStatus?.otherStatus
                ? { memberCount: detail.squareChatStatus.otherStatus.memberCount }
                : null,
              chatImageObsHash: (detail.squareChat as unknown as Record<string, unknown>).chatImageObsHash,
            };
          } catch (err) {
            console.error("[ERROR] チャット詳細取得失敗", err);
            return {
              squareChatMid: String((c.raw as unknown as Record<string, unknown>).squareChatMid),
              name: (c.raw as unknown as Record<string, unknown>).name,
              chat: c.raw,
              chatType: 'square',
              squareStatus: null,
              chatImageObsHash: (c.raw as unknown as Record<string, unknown>).chatImageObsHash,
            };
          }
        }),
      );

      // 個人チャットの情報を追加
      const personalResult: {
        squareChatMid: string;
        name: string;
        chat: unknown;
        chatType: "personal";
        squareStatus: null;
        chatImageObsHash?: string;
      }[] = [];

      for (const contact of personalChats) {
        const contactData = contact as Record<string, unknown>;
        const profile = contactData.targetProfileDetail as Record<string, unknown> | undefined;
        const midValue =
          (typeof contactData.mid === "string" && contactData.mid) ||
          (typeof contactData.id === "string" && contactData.id) ||
          (typeof contactData.userMid === "string" && contactData.userMid) ||
          (typeof contactData.targetUserMid === "string" && contactData.targetUserMid) ||
          (profile && typeof profile.mid === "string" && profile.mid) ||
          null;
        if (!midValue) continue;

        const displayName =
          (typeof contactData.displayName === "string" && contactData.displayName) ||
          (typeof contactData.name === "string" && contactData.name) ||
          (profile && typeof profile.displayName === "string" && profile.displayName) ||
          "Unknown";

        const pictureStatus =
          (typeof contactData.pictureStatus === "string" && contactData.pictureStatus) ||
          (typeof contactData.profileImageObsHash === "string" && contactData.profileImageObsHash) ||
          (profile && typeof profile.pictureStatus === "string" && profile.pictureStatus) ||
          (profile && typeof profile.profileImageObsHash === "string" && profile.profileImageObsHash) ||
          undefined;

        personalResult.push({
          squareChatMid: midValue,
          name: displayName,
          chat: contact,
          chatType: "personal",
          squareStatus: null,
          chatImageObsHash: pictureStatus,
        });
      }

      // グループチャットの情報を追加
      const groupResult: {
        squareChatMid: string;
        name: string;
        chat: unknown;
        chatType: "group";
        squareStatus: null;
        chatImageObsHash?: string;
      }[] = [];

      for (const group of groupChats) {
        if (group && typeof group === "object" && "raw" in group) {
          const chatInstance = group as { raw: Record<string, unknown>; mid?: string; name?: string };
          const raw = chatInstance.raw ?? {};
          const midValue =
            (typeof raw.chatMid === "string" && raw.chatMid) ||
            (typeof chatInstance.mid === "string" && chatInstance.mid) ||
            null;
          if (!midValue) continue;

          const displayName =
            (typeof raw.chatName === "string" && raw.chatName) ||
            (typeof chatInstance.name === "string" && chatInstance.name) ||
            (typeof raw.name === "string" && raw.name) ||
            "Unknown";

          const pictureStatus =
            (typeof raw.chatImageObsHash === "string" && raw.chatImageObsHash) ||
            (typeof raw.pictureStatus === "string" && raw.pictureStatus) ||
            undefined;

          groupResult.push({
            squareChatMid: midValue,
            name: displayName,
            chat: raw,
            chatType: "group",
            squareStatus: null,
            chatImageObsHash: pictureStatus,
          });
          continue;
        }

        const groupData = group as Record<string, unknown>;
        const midValue =
          (typeof groupData.id === "string" && groupData.id) ||
          (typeof groupData.gid === "string" && groupData.gid) ||
          (typeof groupData.mid === "string" && groupData.mid) ||
          (typeof groupData.chatMid === "string" && groupData.chatMid) ||
          null;
        if (!midValue) continue;

        const displayName =
          (typeof groupData.name === "string" && groupData.name) ||
          (typeof groupData.displayName === "string" && groupData.displayName) ||
          "Unknown";

        const pictureStatus =
          (typeof groupData.pictureStatus === "string" && groupData.pictureStatus) ||
          (typeof groupData.chatImageObsHash === "string" && groupData.chatImageObsHash) ||
          undefined;

        groupResult.push({
          squareChatMid: midValue,
          name: displayName,
          chat: group,
          chatType: "group",
          squareStatus: null,
          chatImageObsHash: pictureStatus,
        });
      }

      const personalIds = new Set(personalResult.map((p) => p.squareChatMid));
      const filteredGroupResult = groupResult.filter((group) => !personalIds.has(group.squareChatMid));

      // 全てのチャットを結合
      const result = [...squareResult, ...personalResult, ...filteredGroupResult];

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
      const isPersonalOrGroup = squareChatMid.startsWith("u") || squareChatMid.startsWith("c");
      
      if (isPersonalOrGroup) {
        // 個人チャット・グループチャットの場合
        await client.base.talk.sendMessage({ to: squareChatMid, text });
      } else {
        // スクエアチャットの場合
        await client.base.square.sendMessage({ squareChatMid, text });
      }
      
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
      const isPersonalOrGroup = squareChatMid.startsWith("u") || squareChatMid.startsWith("c");
      
      for (let i = 0; i < sendcount; i++) {
        const processedText = processText(text);
        
        if (isPersonalOrGroup) {
          await client.base.talk.sendMessage({ to: squareChatMid, text: processedText });
        } else {
          await client.base.square.sendMessage({ squareChatMid, text: processedText });
        }
        
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
      
      const isPersonalOrGroup = squareChatMid.startsWith("u") || squareChatMid.startsWith("c");
      
      if (isPersonalOrGroup) {
        await client.base.talk.sendMessage({ to: squareChatMid, text, relatedMessageId });
      } else {
        await client.base.square.sendMessage({ squareChatMid, text, relatedMessageId });
      }
      
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
      
      // チャットタイプを判別（個人チャット・グループチャット・スクエアチャット）
      // squareChatMid が 'u' で始まる場合は個人チャット、'c' で始まる場合はグループチャット
      const isPersonal = squareChatMid.startsWith("u");
      const isGroup = squareChatMid.startsWith("c");
      const isPersonalOrGroup = isPersonal || isGroup;
      
      if (isPersonalOrGroup) {
        // 個人チャット・グループチャットの場合は Talk API を使用
        console.debug("[DEBUG] 個人/グループチャットとして処理", { isPersonal, isGroup });
        try {
          let rawMessages: unknown[] = [];
          
          if (isPersonal) {
            // 個人チャットの場合: sync APIを使用してメッセージを取得
            console.debug("[DEBUG] 個人チャットのメッセージを sync で取得");
            const syncResult = await client.base.talk.sync({ limit: 50 });
            
            // operationsからメッセージを抽出
            const operations = (syncResult as { operations?: unknown[] }).operations || [];
            rawMessages = operations
              .filter((op: unknown) => {
                const operation = op as Record<string, unknown>;
                const opType = operation.type;
                return opType === 25 || opType === 26; // SEND_MESSAGE=25, RECEIVE_MESSAGE=26
              })
              .map((op: unknown) => {
                const operation = op as Record<string, unknown>;
                return operation.message;
              })
              .filter((msg: unknown) => {
                const message = msg as Record<string, unknown>;
                // 対象の個人チャットのメッセージのみフィルタ
                return message.to === squareChatMid || message.from === squareChatMid;
              })
              .slice(0, 50);
          } else if (isGroup) {
            // グループチャットの場合: メッセージボックスから取得
            console.debug("[DEBUG] グループチャットのメッセージをメッセージボックスから取得");
            const boxes = await client.base.talk.getMessageBoxes({
              messageBoxListRequest: {},
            });
            
            const box = boxes.messageBoxes.find((b: { id?: string }) => b.id === squareChatMid);
            if (!box) {
              console.warn("[WARN] メッセージボックスが見つかりません。空の結果を返します。");
              return c.json(
                {
                  events: [],
                  profiles: {},
                  success: true,
                },
                200,
                corsHeaders,
              );
            }

            // メッセージを取得
            const boxData = box as unknown as {
              id: string;
              lastDeliveredMessageId: { messageId: string | number | bigint; deliveredTime: number | bigint };
            };
            rawMessages = await client.base.talk.getPreviousMessagesV2WithRequest({
              request: {
                messageBoxId: boxData.id,
                endMessageId: {
                  messageId: typeof boxData.lastDeliveredMessageId.messageId === "string"
                    ? BigInt(boxData.lastDeliveredMessageId.messageId)
                    : boxData.lastDeliveredMessageId.messageId,
                  deliveredTime: typeof boxData.lastDeliveredMessageId.deliveredTime === "bigint"
                    ? boxData.lastDeliveredMessageId.deliveredTime
                    : BigInt(boxData.lastDeliveredMessageId.deliveredTime),
                },
                messagesCount: 50,
              },
            });
          }
          
          // メッセージを整形
          const events = (Array.isArray(rawMessages) ? rawMessages : []).map((rawMsg: unknown) => {
            const msg = rawMsg as Record<string, unknown>;
            return {
              id: String(msg.id ?? ""),
              isReceive: msg.from !== client.base.profile?.mid,
              text: String(msg.text ?? ""),
              deliveredTime: msg.deliveredTime,
              contentType: msg.contentType,
              messageRelationType: msg.messageRelationType,
              relatedMessageId: msg.relatedMessageId,
              profile: null, // 個人チャットの場合はプロフィール不要
              rawEvent: { type: msg.from === client.base.profile?.mid ? "SEND_MESSAGE" : "RECEIVE_MESSAGE", payload: { message: msg } },
              imageData: null,
              isImage: false,
            };
          });

          return c.json(
            {
              events,
              profiles: {},
              success: true,
            },
            200,
            corsHeaders,
          );
        } catch (err) {
          console.error("[ERROR] 個人/グループチャットメッセージ取得失敗", err);
          return c.json(
            {
              error: "個人/グループチャットのメッセージ取得に失敗しました",
              success: false,
            },
            500,
            corsHeaders,
          );
        }
      }
      
      // スクエアチャットの場合
      console.debug("[DEBUG] スクエアチャットとして処理");
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
    // action = "logout"
    // ----------------------------
    if (action === "logout") {
      // Cookieをクリア（Max-Age=0で有効期限切れにする）
      c.header('Set-Cookie', `sessionId=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
      
      // セッションをDBから削除
      if (d1) {
        const d1db = d1 as unknown as D1Db;
        const delStmt = d1db.prepare("DELETE FROM sessions WHERE session_id = ?");
        const delBound = delStmt.bind(sessionId);
        const delRunFn = delBound.run;
        if (delRunFn) await delRunFn().catch(() => {
          // 削除失敗は無視
        });
      }
      
      console.info("[INFO] ログアウト:", sessionId);
      return c.json(
        { success: true, message: "ログアウトしました" },
        200,
        corsHeaders,
      );
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
};

// -----------------------------------------------------------------------------
// API: /api/session (GET) - セッション確認
// -----------------------------------------------------------------------------
app.get("/api/session", async (c) => {
  try {
    // CookieからセッションIDを取得
    const cookieHeader = c.req.header('Cookie') || '';
    console.log("[DEBUG] /api/session Cookie header:", cookieHeader);
    
    const sessionIdMatch = cookieHeader.match(/sessionId=([^;]+)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : undefined;
    
    console.log("[DEBUG] /api/session SessionId from cookie:", sessionId);

    if (!sessionId) {
      console.log("[DEBUG] /api/session No session ID found");
      return c.json(
        { authenticated: false, error: "セッションが見つかりません" },
        200,
        corsHeaders,
      );
    }

    const d1 = (c.env as Env).LINE_D1;
    console.log("[DEBUG] /api/session D1 available:", !!d1);
    
    const authToken = await getSessionAuthToken(d1, sessionId);
    console.log("[DEBUG] /api/session authToken found:", !!authToken);
    
    if (!authToken) {
      console.log("[DEBUG] /api/session Invalid or expired session");
      return c.json(
        { authenticated: false, error: "セッションが無効です" },
        200,
        corsHeaders,
      );
    }

    console.log("[DEBUG] /api/session Session is valid");
    return c.json(
      { 
        authenticated: true, 
        sessionId: sessionId,
        message: "セッションは有効です" 
      },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error("[ERROR] セッション確認 API", err);
    return c.json(
      { authenticated: false, error: "エラーが発生しました" },
      500,
      corsHeaders,
    );
  }
});

// POST /api/action エンドポイント（旧 POST /）
app.post("/api/action", handleTotalApi);

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
// API: /api/sends/   (POST) - 連投送信
// -----------------------------------------------------------------------------
app.post("/api/sends/", async (c) => {
  try {
    const body = await c.req.json();
    const squareChatMid = body.squareChatMid as string | undefined;
    const text = body.text as string | undefined;
    const sendcount = Number(body.sendcount ?? 1) || 1;
    const read = body.read as boolean | undefined;

    if (!squareChatMid || !text) {
      return c.json(
        { error: "squareChatMid と text は必須です" },
        400,
        corsHeaders,
      );
    }

    // CookieからセッションIDを取得
    const cookieHeader = c.req.header('Cookie') || '';
    const sessionIdMatch = cookieHeader.match(/sessionId=([^;]+)/);
    const sessionId = sessionIdMatch ? sessionIdMatch[1] : undefined;

    if (!sessionId) {
      return c.json(
        { error: "セッションが無効です。再度ログインしてください。" },
        401,
        corsHeaders,
      );
    }
    const d1 = (c.env as Env).LINE_D1;

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

    // 連投送信を実行
    for (let i = 0; i < sendcount; i++) {
      const messageToSend = processText(text);
      await client.base.square.sendMessage({ squareChatMid, text: messageToSend });
      // 短い遅延を入れる
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.info("[INFO] 連投送信完了:", { squareChatMid, sendcount, text });

    return c.json(
      { success: true, message: "連投送信が完了しました" },
      200,
      corsHeaders,
    );
  } catch (err) {
    console.error("[ERROR] 連投送信失敗:", err);
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

    const storage = d1 ? new D1Storage(d1) : new MemoryStorage();
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

    console.log("[DEBUG] /api/login/password D1 available:", !!d1);
    
    // ユーザーを取得または作成
    const userId = await getOrCreateUser(d1, email, userMid);

    await saveSession(
      d1,
      sessionId,
      authToken,
      24,
      refreshToken,
      userMid,
      userId,
    );

    console.info("[INFO] ログインセッション作成:", sessionId);

    // CookieにセッションIDを設定（HttpOnly, Secure, SameSite=Lax）
    c.header('Set-Cookie', `sessionId=${sessionId}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);

    return c.json(
      {
        success: true,
        message: "ログインに成功しました",
        sessionId: sessionId,
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
// アプリ起動
// -----------------------------------------------------------------------------
// Workers エクスポート
console.log("[INFO] LINE 操作サーバー (Worker) 準備完了");
export default app;
