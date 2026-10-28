import * as store from "./store.js";
import { isCovered } from "./sync.js";

function groupRows(rows) {
  const byRecipient = new Map();
  const byGifter = new Map();
  const byStamp = new Map();

  for (const row of rows) {
    addBucket(byRecipient, row.recipientId || row.recipientName, {
      id: row.recipientId,
      name: row.recipientName,
      isTeam: row.recipientIsTeam,
    }, row);
    addBucket(byGifter, row.gifterId || row.gifterName, {
      id: row.gifterId,
      name: row.gifterName,
      avatar: row.gifterAvatar,
    }, row);
    addBucket(byStamp, row.stampId || row.stampName, {
      id: row.stampId,
      name: row.stampName,
      image: row.stampImage,
    }, row);
  }

  return {
    byRecipient: finishBuckets(byRecipient, rows),
    byGifter: finishBuckets(byGifter, rows),
    byStamp: finishBuckets(byStamp, rows),
  };
}

function addBucket(map, key, identity, row) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      ...identity,
      count: 0,
      points: 0,
      people: new Set(),
      stamps: new Map(),
      recipients: new Set(),
    };
    map.set(key, bucket);
  }
  bucket.count += 1;
  bucket.points += row.points || 0;
  bucket.people.add(row.gifterId || row.gifterName);
  bucket.recipients.add(row.recipientId || row.recipientName);
  const stampKey = row.stampName || "不明";
  bucket.stamps.set(stampKey, (bucket.stamps.get(stampKey) || 0) + 1);
}

function pairRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.gifterId || row.gifterName}\0${row.recipientId || row.recipientName}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        gifterName: row.gifterName || "名称非公開",
        gifterAvatar: row.gifterAvatar || "",
        recipientName: row.recipientName || "不明",
        count: 0,
        points: 0,
      };
      map.set(key, bucket);
    }
    bucket.count += 1;
    bucket.points += row.points || 0;
  }
  return [...map.values()].sort(
    (a, b) => b.points - a.points || b.count - a.count || a.gifterName.localeCompare(b.gifterName, "ja"),
  );
}

function topKey(map) {
  let best = "";
  let bestCount = -1;
  for (const [key, count] of map) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function finishBuckets(map) {
  return [...map.values()]
    .map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      avatar: bucket.avatar || "",
      image: bucket.image || "",
      isTeam: bucket.isTeam || 0,
      count: bucket.count,
      points: bucket.points,
      gifters: bucket.people.size,
      recipients: bucket.recipients.size,
      topStamp: topKey(bucket.stamps),
    }))
    .sort((a, b) => b.points - a.points || b.count - a.count);
}

export function aggregateEvent(event) {
  const state = store.getTimeline(event.slug);
  const covered = isCovered(state, event.startedAt);
  if (!covered) {
    return {
      covered: false,
      timeline: {
        complete: !!state.complete,
        oldestAt: state.oldestAt,
        nextOffset: state.nextOffset,
        totalPosts: state.totalPosts,
        giftCount: store.countGifts(event.slug),
      },
    };
  }

  const recipientIds = (event.targets || []).map((target) => String(target.id)).filter(Boolean);
  const rows = store.queryGifts(event.slug, {
    from: event.startedAt,
    to: event.endedAt,
    recipientIds,
  });
  const grouped = groupRows(rows);
  const pairs = pairRows(rows);
  const gifters = new Set(rows.map((row) => row.gifterId || row.gifterName));
  return {
    covered: true,
    scope: recipientIds.length ? "targets" : "all",
    timeline: {
      complete: !!state.complete,
      oldestAt: state.oldestAt,
      nextOffset: state.nextOffset,
      totalPosts: state.totalPosts,
      giftCount: store.countGifts(event.slug),
    },
    summary: {
      count: rows.length,
      totalPoints: rows.reduce((sum, row) => sum + (row.points || 0), 0),
      gifters: gifters.size,
      recipients: grouped.byRecipient.length,
      stamps: grouped.byStamp.length,
    },
    byRecipient: grouped.byRecipient,
    pairs,
    byGifter: grouped.byGifter,
    byStamp: grouped.byStamp,
    rows: withEvents(event.slug, rows).slice(0, 1000),
    rowTotal: rows.length,
  };
}

export function allGiftRows(event) {
  const recipientIds = (event.targets || []).map((target) => String(target.id)).filter(Boolean);
  return withEvents(
    event.slug,
    store.queryGifts(event.slug, {
      from: event.startedAt,
      to: event.endedAt,
      recipientIds,
    }),
  );
}

function giftMatchesEvent(event, gift) {
  const at = gift.createdAt;
  if (!at) return false;
  if (event.startedAt && at < event.startedAt) return false;
  if (event.endedAt) {
    if (at > event.endedAt) return false;
  } else if (!event.isOpen) {
    return false;
  }
  const targets = event.targets || [];
  if (!targets.length) return true;
  return targets.some((target) => String(target.id) === String(gift.recipientId));
}

export function withEvents(slug, rows) {
  const events = store.listEvents(slug);
  return rows.map((row) => {
    const matched = events
      .filter((event) => giftMatchesEvent(event, row))
      .sort((a, b) => {
        const specific = (b.targets?.length ? 1 : 0) - (a.targets?.length ? 1 : 0);
        return specific || String(a.startedAt).localeCompare(String(b.startedAt));
      });
    return { ...row, eventTitles: matched.map((event) => event.title) };
  });
}
