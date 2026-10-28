import {
  fetchCommunities,
  fetchCommunityProfile,
  fetchOpenCommunityIds,
  fetchRanking,
  fetchRewards,
  fetchTimelinePage,
  isTestCommunity,
  mapGift,
} from "./engate.js";
import * as store from "./store.js";

const COMMUNITY_TTL = 6 * 60 * 60 * 1000;
const TEAM_TTL = 30 * 60 * 1000;
const RANKING_TTL = 10 * 60 * 1000;

const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function fresh(iso, ttl) {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) < ttl;
}

export function isCovered(state, until) {
  if (!state) return false;
  if (state.complete) return true;
  if (state.oldestAt && until && Date.parse(state.oldestAt) <= Date.parse(until)) return true;
  return false;
}

export async function ensureCommunities(force = false) {
  const fetchedAt = store.getMeta("communities_fetched_at");
  if (!force && fresh(fetchedAt, COMMUNITY_TTL) && store.listCommunities().length) {
    return store.listCommunities();
  }
  const list = await fetchCommunities();
  store.saveCommunities(list);
  return store.listCommunities();
}

export async function ensureOpenEvents(slug, force = false) {
  const key = `open_events:${slug}`;
  if (!force && fresh(store.getMeta(key), TEAM_TTL)) return store.listEvents(slug);
  const events = await fetchRewards(slug, 1);
  store.upsertEvents(slug, events);
  store.setMeta(key, new Date().toISOString());
  return store.listEvents(slug);
}

export async function ensureTeamEvents(slug, force = false) {
  const community = store.communityBySlug(slug);
  if (!community) {
    await ensureCommunities(true);
  }
  const known = store.communityBySlug(slug);
  if (!known) {
    const error = new Error("チームが見つかりません");
    error.status = 404;
    throw error;
  }
  if (!force && fresh(store.teamFetchedAt(slug), TEAM_TTL)) {
    return { community: known, events: store.listEvents(slug) };
  }
  const [openEvents, closedEvents] = await Promise.all([fetchRewards(slug, 1), fetchRewards(slug, 0)]);
  const byId = new Map();
  for (const event of [...openEvents, ...closedEvents]) byId.set(event.id, event);
  const events = [...byId.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  store.saveEvents(slug, events);
  return { community: store.communityBySlug(slug), events: store.listEvents(slug) };
}

export async function ensureRanking(slug, eventId, force = false) {
  const cached = store.getRanking(eventId);
  if (!force && cached && fresh(cached.updatedAt, RANKING_TTL)) return cached;
  const ranking = await fetchRanking(slug, eventId);
  store.saveRanking(eventId, ranking);
  return store.getRanking(eventId);
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function loadHome(force = false) {
  const communities = await ensureCommunities(force);
  const openIds = await fetchOpenCommunityIds();
  const byId = new Map(communities.map((community) => [community.id, community]));
  const missing = [];
  for (const id of openIds.filter((communityId) => !byId.has(communityId))) {
    try {
      const community = await fetchCommunityProfile(id);
      if (!community.slug || isTestCommunity(community)) continue;
      byId.set(community.id, community);
      store.saveCommunities([community]);
    } catch (error) {
      console.error("community profile failed", id, error.message);
      missing.push(id);
    }
  }
  const slugs = [...new Set(openIds.map((id) => byId.get(id)?.slug).filter(Boolean))];

  await mapPool(slugs, 4, async (slug) => {
    try {
      await ensureOpenEvents(slug, force);
    } catch (error) {
      console.error("open events failed", slug, error.message);
    }
  });

  const openEvents = [];
  for (const slug of slugs) {
    for (const event of store.listEvents(slug)) {
      if (event.isOpen && !event.isFuture) openEvents.push(event);
    }
  }
  openEvents.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));

  const rankings = await mapPool(openEvents, 4, async (event) => {
    try {
      const ranking = await ensureRanking(event.slug, event.id, force);
      return { id: event.id, totalPoint: ranking.totalPoint, count: ranking.count };
    } catch (error) {
      console.error("ranking failed", event.id, error.message);
      return { id: event.id, totalPoint: null, count: null };
    }
  });
  const rankingById = new Map(rankings.filter(Boolean).map((ranking) => [ranking.id, ranking]));

  return {
    fetchedAt: new Date().toISOString(),
    missingCommunityIds: missing,
    communities: [...byId.values()]
      .filter((community) => !isTestCommunity(community))
      .sort((a, b) => b.followers - a.followers || a.name.localeCompare(b.name, "ja"))
      .map(publicCommunity),
    openEvents: openEvents.map((event) => ({
      ...publicEvent(event),
      community: publicCommunity(byId.get(event.communityId) || store.communityBySlug(event.slug)),
      ranking: rankingById.get(event.id) || null,
    })),
  };
}

export function publicCommunity(community) {
  if (!community) return null;
  return {
    id: community.id,
    slug: community.slug,
    name: community.name,
    logo: community.logo,
    color: community.color,
    followers: community.followers,
  };
}

export function publicEvent(event) {
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    isOpen: event.isOpen,
    isFuture: event.isFuture,
    isClose: event.isClose,
    image: event.image,
    targets: event.targets,
    conditions: event.conditions,
    rewardType: event.rewardType,
    status: eventStatus(event),
    url: `https://engate.jp/communities/${event.slug}/rewards/${event.id}/`,
  };
}

export function eventStatus(event) {
  if (event.isFuture) return "upcoming";
  if (event.isOpen) return "open";
  return "closed";
}

function rememberPosts(slug, posts) {
  store.savePosts(slug, posts, mapGift);
}

export async function advanceTimeline(slug, { until, refreshHead = false, maxPages = 4 } = {}) {
  return withLock(`timeline:${slug}`, async () => {
    if (!store.communityBySlug(slug)) {
      await ensureCommunities(false);
    }
    if (!store.communityBySlug(slug)) {
      const error = new Error("チームが見つかりません");
      error.status = 404;
      throw error;
    }

    let pages = 0;
    let state = store.getTimeline(slug);

    if (refreshHead && state.nextOffset > 0) {
      let offset = 0;
      while (pages < 3) {
        const page = await fetchTimelinePage(slug, offset);
        const posts = page.posts;
        if (!posts.length) {
          state = { ...state, complete: 1, totalPosts: page.total || state.totalPosts };
          store.setTimeline(state);
          break;
        }
        const known = store.seenSet(
          slug,
          posts.map((post) => Number(post.id)),
        );
        rememberPosts(
          slug,
          posts.filter((post) => !known.has(Number(post.id))),
        );
        pages += 1;
        state = { ...store.getTimeline(slug), totalPosts: page.total || state.totalPosts };
        store.setTimeline({ ...store.getTimeline(slug), totalPosts: page.total || store.getTimeline(slug).totalPosts });
        if (known.size > 0 || posts.length < 100) break;
        offset += posts.length;
      }
      state = store.getTimeline(slug);
    }

    while (pages < maxPages && !isCovered(state, until)) {
      const page = await fetchTimelinePage(slug, state.nextOffset || 0);
      const posts = page.posts;
      if (!posts.length) {
        state = {
          ...state,
          complete: 1,
          totalPosts: page.total || state.totalPosts,
        };
        store.setTimeline(state);
        break;
      }
      rememberPosts(slug, posts);
      const oldestAt = posts[posts.length - 1].created_at || state.oldestAt;
      const nextOffset = (state.nextOffset || 0) + posts.length;
      const complete = posts.length < 100 ? 1 : 0;
      state = {
        slug,
        nextOffset,
        oldestAt,
        complete,
        totalPosts: page.total || state.totalPosts,
      };
      store.setTimeline(state);
      pages += 1;
      if (complete || isCovered(state, until)) break;
    }

    state = store.getTimeline(slug);
    return {
      done: isCovered(state, until),
      complete: !!state.complete,
      oldestAt: state.oldestAt,
      nextOffset: state.nextOffset,
      totalPosts: state.totalPosts,
      giftCount: store.countGifts(slug),
      pages,
    };
  });
}
