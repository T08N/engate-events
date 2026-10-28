const PAGE = "https://engate.jp/communities/tokyo-warriors/rewards/";

let configPromise = null;
const queue = [];
let active = 0;
const MAX_CONCURRENCY = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    active += 1;
    (async () => {
      await sleep(60);
      return job.fn();
    })()
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

async function loadConfig() {
  const res = await fetch(PAGE, {
    headers: { "User-Agent": "engate-events-aggregator", Accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Engateの設定を取得できませんでした (${res.status})`);
  const html = await res.text();
  const pick = (key) => {
    const match = html.match(new RegExp(`${key}:"([^"]+)"`));
    if (!match) throw new Error(`Engateの設定 ${key} が見つかりません`);
    return match[1];
  };
  return {
    apiHost: pick("apiHost"),
    apiVersion: pick("apiVersion"),
    apiKey: pick("apiKey"),
  };
}

function config() {
  if (!configPromise) configPromise = loadConfig();
  return configPromise;
}

export async function engateGet(path) {
  const cfg = await config();
  return schedule(async () => {
    const url = `${cfg.apiHost}/${cfg.apiVersion}${path}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": cfg.apiKey,
        "X-ENGATE-DOMAIN": "engate.jp",
        "User-Agent": "engate-events-aggregator",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Engate API ${res.status}: ${path}`);
    const data = await res.json();
    if (data && typeof data.code === "string" && !data.code.startsWith("#0000")) {
      throw new Error(data.message || `Engate API ${data.code}`);
    }
    return data;
  });
}

export function mapCommunity(raw) {
  return {
    id: raw.id,
    slug: raw.name_en,
    name: raw.name,
    logo: raw.logo || "",
    color: typeof raw.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.color) ? raw.color : "#e25b12",
    followers: Number(raw.followers_count) || 0,
  };
}

export function mapEvent(slug, raw) {
  return {
    id: Number(raw.id),
    communityId: Number(raw.community_id) || 0,
    slug,
    title: raw.title || "(無題)",
    startedAt: raw.started_at || null,
    endedAt: raw.ended_at || null,
    isOpen: raw.is_open ? 1 : 0,
    isFuture: raw.is_future ? 1 : 0,
    isClose: raw.is_close ? 1 : 0,
    image: raw.image || "",
    targets: (raw.target_players || []).map((player) => ({
      id: player.id,
      name: player.account_name || "",
      avatar: player.avatar || "",
      number: player.player_num || "",
      isTeam: player.is_team_account ? 1 : 0,
    })),
    conditions: raw.reward_conditions || [],
    rewardType: raw.reward_type || [],
  };
}

export function mapGift(slug, post) {
  const gift = post.giftings;
  const catalog = gift?.gifting_catalogs;
  if (!gift || !catalog) return null;
  const player = gift.player || {};
  const user = post.user || {};
  const reply = gift.reply_stamp;
  return {
    postId: Number(post.id),
    slug,
    createdAt: post.created_at,
    gifterId: String(user.customer_id || user.id || ""),
    gifterName: user.account_name || "名称非公開",
    gifterAvatar: user.avatar || "",
    recipientId: player.id == null ? "" : String(player.id),
    recipientName: player.account_name || "不明",
    recipientIsTeam: player.is_team_account ? 1 : 0,
    stampId: catalog.id == null ? "" : String(catalog.id),
    stampName: catalog.name || "不明",
    stampImage: catalog.image || "",
    points: Number(catalog.point) || 0,
    replyName: reply?.name || reply?.stamp_name || "",
  };
}

export async function fetchCommunities() {
  const data = await engateGet("/communities");
  return (data.communities || []).map(mapCommunity).filter((community) => community.slug);
}

export async function fetchCommunityProfile(idOrSlug) {
  const data = await engateGet(`/communities/${encodeURIComponent(idOrSlug)}/profile`);
  return mapCommunity(data);
}

export function isTestCommunity(community) {
  return /test|テスト/i.test(`${community?.name || ""} ${community?.slug || ""}`);
}

export async function fetchOpenCommunityIds() {
  const data = await engateGet("/communities/open_rewards");
  return (data.community_id || []).map(Number);
}

export async function fetchRewards(slug, open) {
  const all = [];
  let offset = 0;
  const limit = 50;
  while (offset < 5000) {
    const data = await engateGet(
      `/communities/${encodeURIComponent(slug)}/rewards?open=${open}&limit=${limit}&offset=${offset}`,
    );
    const rows = data.rewards || [];
    all.push(...rows.map((row) => mapEvent(slug, row)));
    offset += rows.length;
    const count = Number(data.count || 0);
    if (!rows.length || rows.length < limit || offset >= count) break;
  }
  return all;
}

export async function fetchRanking(slug, eventId) {
  const ranking = [];
  let page = 1;
  let totalPoint = 0;
  let count = 0;
  while (page <= 30) {
    const data = await engateGet(
      `/communities/${encodeURIComponent(slug)}/rewards/${eventId}/ranking?page=${page}&limit=100`,
    );
    totalPoint = Number(data.total_point || 0);
    count = Number(data.count || 0);
    const rows = data.ranking || [];
    ranking.push(
      ...rows.map((row) => ({
        rank: Number(row.rank) || 0,
        id: String(row.id || ""),
        name: row.customer_profile_name || "名称非公開",
        avatar: row.customer_profile_image || "",
        points: Number(row.tipping_point) || 0,
        awarded: !!row.is_award,
      })),
    );
    if (!rows.length || ranking.length >= count) break;
    page += 1;
  }
  return { totalPoint, count, ranking };
}

export async function fetchTimelinePage(slug, offset, limit = 100) {
  const data = await engateGet(
    `/communities/${encodeURIComponent(slug)}/timeline?post_only=off&offset=${offset}&limit=${limit}`,
  );
  return {
    total: Number(data.count || 0),
    posts: data.posts || [],
  };
}
