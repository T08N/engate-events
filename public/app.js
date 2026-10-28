const app = document.querySelector("#app");

const state = {
  home: null,
  teamQuery: "",
};

document.body.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, "", url.pathname + url.search + url.hash);
  route();
});
window.addEventListener("popstate", route);
route();

function route() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  const eventMatch = path.match(/^\/teams\/([^/]+)\/events\/(\d+)$/);
  const teamMatch = path.match(/^\/teams\/([^/]+)$/);
  if (path === "/") return renderHome();
  if (path === "/teams") return renderTeams();
  if (eventMatch) return renderEvent(decodeURIComponent(eventMatch[1]), eventMatch[2]);
  if (teamMatch) return renderTeam(decodeURIComponent(teamMatch[1]));
  app.innerHTML = `<div class="empty">ページが見つかりません。<a href="/">開催中のイベントへ戻る</a></div>`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || "応答を読めませんでした" };
  }
  if (!response.ok) throw new Error(data.error || "取得に失敗しました");
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function pts(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Number(value).toLocaleString("ja-JP")} PT`;
}

function fmt(iso) {
  if (!iso) return "未定";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未定";
  const year = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric" }).format(date);
  const thisYear = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric" }).format(new Date());
  const options = {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (year !== thisYear) options.year = "numeric";
  return new Intl.DateTimeFormat("ja-JP", options).format(date);
}

function statusLabel(status) {
  if (status === "open") return "開催中";
  if (status === "upcoming") return "開催予定";
  return "終了";
}

function conditionText(conditions) {
  const points = [];
  for (const item of conditions || []) {
    for (const point of item.point || item.points || []) points.push(Number(point));
  }
  const unique = [...new Set(points.filter((point) => !Number.isNaN(point)))].sort((a, b) => a - b);
  if (!unique.length) return "ポイント条件の表示なし";
  return unique.map((point) => `${point.toLocaleString("ja-JP")} PT以上`).join("、");
}

async function renderHome() {
  app.innerHTML = `<div class="loading">開催中のイベントを Engate から集めています。初回はチーム数ぶん時間がかかります。</div>`;
  try {
    const refresh = new URLSearchParams(location.search).get("refresh") === "1";
    state.home = await api(`/api/home${refresh ? "?refresh=1" : ""}`);
    if (refresh) history.replaceState(null, "", "/");
    drawHome();
  } catch (error) {
    app.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

function stepsHtml(current, links) {
  const steps = [
    { id: "team", label: "チーム選択" },
    { id: "event", label: "イベント選択" },
    { id: "total", label: "集計" },
  ];
  return `<nav class="steps" aria-label="集計の手順">${steps
    .map((step, index) => {
      const className = step.id === current ? "step current" : "step";
      const href = links[step.id];
      const inner = `<span class="step-num">${index + 1}</span>${esc(step.label)}`;
      return href
        ? `<a class="${className}" href="${esc(href)}">${inner}</a>`
        : `<span class="${className}">${inner}</span>`;
    })
    .join("")}</nav>`;
}

function drawHome() {
  const { openEvents, communities, missingCommunityIds } = state.home;
  const totalPoints = openEvents.reduce((sum, event) => sum + (event.ranking?.totalPoint || 0), 0);
  app.innerHTML = `
    ${stepsHtml("team", { team: "/" })}
    <section class="picker" id="team-picker">
      <p class="eyebrow">TEAM</p>
      <h2>チームを選ぶ</h2>
      <p class="lede">チームを選ぶと、次のページでイベントを選べます。選んだイベントの集計が開きます。</p>
      <div class="picker-row">
        <input class="search" id="picker-search" placeholder="チーム名で絞り込む" />
        <select class="select" id="picker-select" aria-label="チーム"></select>
        <button class="button" id="picker-next" type="button">イベントを選ぶ</button>
      </div>
    </section>
    <section class="hero">
      <p class="eyebrow">OPEN EVENTS</p>
      <h1>開催中のイベントを、<br>ギフト単位で残す。</h1>
      <p class="lede">ギフト先、ギフティング者、スタンプ、ポイントを、開催中と過去のイベントごとに集めます。数字は Engate の公開データです。</p>
      <div class="stats">
        <div class="stat"><b>${openEvents.length}</b>開催中</div>
        <div class="stat"><b>${communities.length}</b>チーム</div>
        <div class="stat"><b>${totalPoints.toLocaleString("ja-JP")}</b>開催中の公式PT</div>
      </div>
    </section>
    <div class="section-head" id="open-events">
      <div>
        <h2>開催中</h2>
        <p>公式ランキングの合計ポイントと参加人数です。明細はイベントを開いて集計します。</p>
      </div>
      <a class="button-ghost" href="/?refresh=1">再取得</a>
    </div>
    ${missingCommunityIds?.length ? `<p class="meta">チーム一覧に無い開催コミュニティが ${missingCommunityIds.length} 件あります。</p>` : ""}
    <div class="event-list">
      ${openEvents.length ? openEvents.map(eventCard).join("") : `<div class="empty">今、公開されている開催中イベントはありません。</div>`}
    </div>
    <div class="section-head">
      <div>
        <h2>チームから過去分を見る</h2>
        <p>終了したイベントはチームページに並びます。</p>
      </div>
      <input class="search" id="team-search" placeholder="チーム名で探す" value="${esc(state.teamQuery)}" />
    </div>
    <div class="team-grid" id="team-grid">${teamCards(communities)}</div>
  `;
  const search = document.querySelector("#team-search");
  search.addEventListener("input", () => {
    state.teamQuery = search.value;
    document.querySelector("#team-grid").innerHTML = teamCards(communities);
  });
  bindTeamPicker(communities);
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

function bindTeamPicker(communities) {
  const search = document.querySelector("#picker-search");
  const select = document.querySelector("#picker-select");
  const next = document.querySelector("#picker-next");
  const paint = () => {
    const query = search.value.trim().toLowerCase();
    const selected = select.value;
    const list = communities.filter((community) => {
      if (!query) return true;
      return community.name.toLowerCase().includes(query) || community.slug.toLowerCase().includes(query);
    });
    select.innerHTML = list
      .map((community) => `<option value="${esc(community.slug)}">${esc(community.name)}</option>`)
      .join("");
    if (list.some((community) => community.slug === selected)) select.value = selected;
    next.disabled = !select.value;
  };
  search.addEventListener("input", paint);
  select.addEventListener("change", paint);
  next.addEventListener("click", () => {
    if (!select.value) return;
    history.pushState(null, "", `/teams/${encodeURIComponent(select.value)}`);
    route();
  });
  paint();
}

function teamCards(communities) {
  const query = state.teamQuery.trim().toLowerCase();
  const list = communities.filter((community) => {
    if (!query) return true;
    return community.name.toLowerCase().includes(query) || community.slug.toLowerCase().includes(query);
  });
  if (!list.length) return `<div class="empty">一致するチームはありません。</div>`;
  return list
    .map(
      (community) => `
        <a class="team-card" href="/teams/${esc(community.slug)}">
          <img src="${esc(community.logo)}" alt="" />
          <span>
            <strong>${esc(community.name)}</strong>
            <span>フォロワー ${Number(community.followers).toLocaleString("ja-JP")}</span>
          </span>
        </a>`,
    )
    .join("");
}

function eventCard(event) {
  const community = event.community;
  return `
    <a class="event-card" href="/teams/${esc(event.slug)}/events/${event.id}" style="border-left-color:${esc(community?.color || "#e4570e")}">
      <img class="cover" src="${esc(event.image)}" alt="" />
      <div>
        <div class="team-line">
          ${community?.logo ? `<img src="${esc(community.logo)}" alt="" />` : ""}
          <span>${esc(community?.name || event.slug)}</span>
          <span class="pill ${esc(event.status)}">${statusLabel(event.status)}</span>
        </div>
        <h3>${esc(event.title)}</h3>
        <div class="meta">${fmt(event.startedAt)} 〜 ${fmt(event.endedAt)}</div>
      </div>
      ${
        event.ranking
          ? `<div class="points-col">
        <strong>${Number(event.ranking.totalPoint).toLocaleString("ja-JP")}</strong>
        <span>公式 ${event.ranking.count}人</span>
      </div>`
          : ""
      }
    </a>`;
}

async function renderTeams() {
  if (!state.home) {
    app.innerHTML = `<div class="loading">チーム一覧を読み込んでいます。</div>`;
    try {
      state.home = await api("/api/home");
    } catch (error) {
      app.innerHTML = `<div class="error">${esc(error.message)}</div>`;
      return;
    }
  }
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">TEAMS</p>
      <h1>チーム</h1>
      <p class="lede">チームを開くと、開催中・開催予定・終了したイベントが出ます。</p>
    </section>
    <div class="toolbar">
      <input class="search" id="team-search" placeholder="チーム名で探す" value="${esc(state.teamQuery)}" />
    </div>
    <div class="team-grid" id="team-grid">${teamCards(state.home.communities)}</div>
  `;
  document.querySelector("#team-search").addEventListener("input", (event) => {
    state.teamQuery = event.target.value;
    document.querySelector("#team-grid").innerHTML = teamCards(state.home.communities);
  });
}

async function renderTeam(slug) {
  app.innerHTML = `<div class="loading">イベント一覧を読み込んでいます。</div>`;
  try {
    const refresh = new URLSearchParams(location.search).get("refresh") === "1";
    const data = await api(`/api/teams/${encodeURIComponent(slug)}${refresh ? "?refresh=1" : ""}`);
    if (refresh) history.replaceState(null, "", `/teams/${slug}`);
    const community = data.community;
    app.innerHTML = `
      ${stepsHtml("event", { team: "/", event: `/teams/${slug}` })}
      <p class="crumb"><a href="/">チーム選択</a> / ${esc(community.name)}</p>
      <section class="hero">
        <div class="team-line">
          <img src="${esc(community.logo)}" alt="" style="width:56px;height:56px;border-radius:14px" />
          <div>
            <p class="eyebrow">EVENT</p>
            <h1>イベントを選ぶ</h1>
            <p class="lede">${esc(community.name)}の開催中・過去イベントです。選ぶと集計が開きます。</p>
          </div>
        </div>
        <div class="actions"><a class="button-ghost" href="/teams/${esc(slug)}?refresh=1">イベント一覧を再取得</a></div>
      </section>
      ${eventSection("開催中", data.open, community)}
      ${eventSection("開催予定", data.upcoming, community)}
      ${eventSection("終了", data.closed, community)}
    `;
  } catch (error) {
    app.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

function eventSection(title, events, community) {
  return `
    <div class="section-head"><h2>${esc(title)}</h2><p>${events.length}件</p></div>
    <div class="event-list">
      ${
        events.length
          ? events.map((event) => eventCard({ ...event, community, ranking: null })).join("")
          : `<div class="empty">${esc(title)}のイベントはありません。</div>`
      }
    </div>`;
}

async function renderEvent(slug, eventId) {
  app.innerHTML = `<div class="loading">イベントと公式ランキングを読み込んでいます。</div>`;
  try {
    const data = await api(`/api/teams/${encodeURIComponent(slug)}/events/${eventId}`);
    drawEvent(data);
  } catch (error) {
    app.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

function drawEvent(data) {
  const { community, event, ranking, aggregate } = data;
  const gifterStamps = new Map((aggregate.byGifter || []).map((row) => [row.id, row]));
  app.innerHTML = `
    ${stepsHtml("total", { team: "/", event: `/teams/${event.slug}`, total: `/teams/${event.slug}/events/${event.id}` })}
    <p class="crumb"><a href="/">チーム選択</a> / <a href="/teams/${esc(event.slug)}">${esc(community.name)}</a> / 集計</p>
    <section class="hero-layout">
      <img class="hero-banner" src="${esc(event.image)}" alt="" />
      <div>
        <div class="team-line">
          <img src="${esc(community.logo)}" alt="" />
          <span>${esc(community.name)}</span>
          <span class="pill ${esc(event.status)}">${statusLabel(event.status)}</span>
        </div>
        <h1>${esc(event.title)}</h1>
        <p class="meta">${fmt(event.startedAt)} 〜 ${fmt(event.endedAt)}</p>
        <p class="meta">条件: ${esc(conditionText(event.conditions))}</p>
        <div class="chips">
          ${
            event.targets?.length
              ? event.targets
                  .map(
                    (target) => `<span class="chip">${target.avatar ? `<img class="avatar" src="${esc(target.avatar)}" alt="" />` : ""}<span>${esc(target.name)}</span></span>`,
                  )
                  .join("")
              : `<span class="chip">ギフト先の指定なし。期間内の公開ギフトをすべて数えます。</span>`
          }
        </div>
        <div class="actions">
          ${
            aggregate.covered
              ? `<a class="button" href="/api/teams/${esc(event.slug)}/events/${event.id}/gifts.csv">CSVをダウンロード</a>`
              : ""
          }
          <a class="button-ghost" href="${esc(event.url)}" target="_blank" rel="noreferrer">Engateで開く</a>
        </div>
      </div>
    </section>
    ${
      aggregate.covered
        ? `<div class="kpis">
      <div class="kpi"><span class="kpi-kicker">公式の合計</span><b>${pts(ranking.totalPoint)}</b><span class="kpi-hint">${ranking.count}人がエントリーしたポイント</span></div>
      <div class="kpi"><span class="kpi-kicker">集めた合計</span><b>${pts(aggregate.summary.totalPoints)}</b><span class="kpi-hint">公開されたギフトを1件ずつ足した数</span></div>
      <div class="kpi"><span class="kpi-kicker">ギフトの件数</span><b>${aggregate.summary.count.toLocaleString("ja-JP")}</b><span class="kpi-hint">期間内の公開ギフト</span></div>
      <div class="kpi"><span class="kpi-kicker">スタンプの種類</span><b>${aggregate.summary.stamps.toLocaleString("ja-JP")}</b><span class="kpi-hint">使われたスタンプ</span></div>
    </div>
    ${differenceCallout(ranking, aggregate, event)}`
        : ""
    }
    ${syncPanel(event, aggregate, ranking)}
    <div class="section-head"><h2>公式ランキング</h2><p>Engate のイベント順位です。</p></div>
    <section class="panel">
      ${
        ranking.ranking?.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>順位</th><th>ギフティング者</th><th class="num">ポイント</th><th>明細での主なスタンプ</th></tr></thead>
              <tbody>
                ${ranking.ranking
                  .map((row) => {
                    const detail = gifterStamps.get(row.id);
                    return `<tr>
                      <td>${row.rank}${row.awarded ? ` <span class="pill award">受賞</span>` : ""}</td>
                      <td><div class="name-cell">${row.avatar ? `<img class="avatar" src="${esc(row.avatar)}" alt="" />` : ""}<span>${esc(row.name)}</span></div></td>
                      <td class="num">${pts(row.points)}</td>
                      <td>${detail ? `${esc(detail.topStamp)} / ${detail.count}件` : "—"}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table></div>`
          : `<div class="empty">公式ランキングはまだ空です。</div>`
      }
    </section>
    ${
      aggregate.covered
        ? `<div class="section-head">
      <div>
        <h2>ギフト明細</h2>
        <p>公開タイムライン上の、期間内${event.targets?.length ? "かつ対象ギフト先" : ""}のギフティングです。</p>
      </div>
    </div>
    <section class="panel" id="detail-panel">${detailPanel(aggregate)}</section>`
        : ""
    }
  `;
  bindSync(event);
  bindDetails(aggregate);
}

function differenceCallout(ranking, aggregate, event) {
  if (!aggregate.covered) return "";
  const official = Number(ranking.totalPoint) || 0;
  const detailed = aggregate.summary.totalPoints;
  if (official === detailed) {
    return `<div class="callout">公式ランキングの合計と、期間内ギフト明細の合計は一致しています。</div>`;
  }
  return `<div class="callout">公式ランキングは ${pts(official)}、明細は ${pts(detailed)} です。公式側はエントリーしたギフティングの合計で、明細は${event.targets?.length ? "対象ギフト先への" : "期間内の"}公開ギフトを1件ずつ足したものです。</div>`;
}

function syncPanel(event, aggregate, ranking) {
  const timeline = aggregate.timeline;
  const hasSaved = (timeline?.giftCount || 0) > 0 || (timeline?.nextOffset || 0) > 0;
  let status = "まだこのチームの投稿は読んでいません。";
  if (aggregate.covered && timeline && !timeline.complete) {
    status = `イベント開始より前の投稿（${fmt(timeline.oldestAt)}）まで読みました。`;
  } else if (timeline?.totalPosts) {
    status = `${timeline.nextOffset || 0} / ${timeline.totalPosts} 投稿を確認。ギフト ${timeline.giftCount || 0} 件を保存。`;
  }
  const reset = hasSaved
    ? `<button class="button-ghost" id="reset-button" type="button">集め直す</button>`
    : "";
  if (!aggregate.covered) {
    return `
      <section class="guide" id="sync-panel">
        <p class="eyebrow">次にすること</p>
        <h2>ギフトの中身を集める</h2>
        <p class="lede">今ある数字は、Engate公式の合計だけです。誰が、どのスタンプを、何ポイント送ったかは、下のボタンで集めます。</p>
        <div class="guide-official">
          <span>公式の合計</span>
          <strong>${pts(ranking.totalPoint)}</strong>
          <span>${ranking.count}人</span>
        </div>
        <p class="meta" id="sync-status">${esc(status)}</p>
        <div class="progress-track"><div class="progress-bar" id="sync-bar"></div></div>
        <div class="actions">
          <button class="button" id="sync-button" type="button">ギフトを集める</button>
          ${reset}
        </div>
        <p class="guide-note">集まると、件数・スタンプの種類・CSVダウンロードが出ます。</p>
      </section>
    `;
  }
  return `
    <section class="panel" id="sync-panel">
      <p>この期間まで投稿を確認済みです。新しい投稿があれば、もう一度集められます。</p>
      <p class="meta" id="sync-status">${esc(status)}</p>
      <div class="progress-track"><div class="progress-bar" id="sync-bar"></div></div>
      <div class="actions">
        <button class="button" id="sync-button" type="button">最新の投稿を反映</button>
        ${reset}
      </div>
    </section>
  `;
}

function bindSync(event) {
  const button = document.querySelector("#sync-button");
  const reset = document.querySelector("#reset-button");
  button.addEventListener("click", () => runSync(event, false));
  reset?.addEventListener("click", async () => {
    if (!window.confirm("保存したギフト明細を消して、取り直します。")) return;
    button.disabled = true;
    reset.disabled = true;
    await api(`/api/teams/${encodeURIComponent(event.slug)}/timeline/reset`, { method: "POST" });
    await runSync(event, false);
  });
}

async function runSync(event, started) {
  const button = document.querySelector("#sync-button");
  const reset = document.querySelector("#reset-button");
  button.disabled = true;
  if (reset) reset.disabled = true;
  let refreshHead = !started;
  let guard = 0;
  try {
    while (guard < 80) {
      guard += 1;
      const progress = await api(`/api/teams/${encodeURIComponent(event.slug)}/timeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ until: event.startedAt, refreshHead }),
      });
      refreshHead = false;
      const ratio = progress.totalPosts ? Math.min(100, Math.round((progress.nextOffset / progress.totalPosts) * 100)) : 0;
      const status = document.querySelector("#sync-status");
      const bar = document.querySelector("#sync-bar");
      if (status) status.textContent = `${progress.nextOffset} / ${progress.totalPosts || "?"} 投稿を確認。保存ギフト ${progress.giftCount} 件。`;
      if (bar) bar.style.width = `${progress.done ? 100 : ratio}%`;
      if (progress.done) break;
      if (!progress.pages) break;
    }
    const data = await api(`/api/teams/${encodeURIComponent(event.slug)}/events/${event.id}`);
    drawEvent(data);
  } catch (error) {
    const status = document.querySelector("#sync-status");
    if (status) status.textContent = error.message;
    button.disabled = false;
    if (reset) reset.disabled = false;
  }
}

function detailPanel(aggregate) {
  if (!aggregate.covered) return `<div class="empty">「ギフトを集める」を押すと、スタンプごとの内訳がここに出ます。</div>`;
  if (!aggregate.summary.count) return `<div class="empty">この期間の公開ギフトは見つかりませんでした。</div>`;
  return `
    <div class="tabs" id="detail-tabs">
      <button type="button" data-tab="recipient" class="active">ギフト先</button>
      <button type="button" data-tab="gifter">ギフティング者</button>
      <button type="button" data-tab="stamp">スタンプ</button>
      <button type="button" data-tab="rows">明細</button>
    </div>
    <div class="table-wrap" id="detail-table"></div>
    <p class="meta" id="detail-note"></p>
  `;
}

function bindDetails(aggregate) {
  if (!aggregate.covered || !aggregate.summary?.count) return;
  const buttons = [...document.querySelectorAll("#detail-tabs button")];
  const show = (tab) => {
    for (const button of buttons) button.classList.toggle("active", button.dataset.tab === tab);
    document.querySelector("#detail-table").innerHTML = detailTable(tab, aggregate);
    const note = document.querySelector("#detail-note");
    note.textContent = tab === "rows" && aggregate.rowTotal > aggregate.rows.length
      ? `明細は新しい順に ${aggregate.rows.length} 件まで表示しています。全 ${aggregate.rowTotal} 件は CSV に入っています。`
      : `${aggregate.summary.gifters} 人が ${aggregate.summary.recipients} 先へ、${aggregate.summary.stamps} 種類のスタンプを送っています。`;
  };
  for (const button of buttons) button.addEventListener("click", () => show(button.dataset.tab));
  show("recipient");
}

function detailTable(tab, aggregate) {
  if (tab === "recipient") {
    return table(
      ["ギフティング者", "ギフト先", "件数", "合計"],
      (aggregate.pairs || []).map((row) => [
        `<div class="name-cell">${row.gifterAvatar ? `<img class="avatar" src="${esc(row.gifterAvatar)}" alt="" />` : ""}<span>${esc(row.gifterName)}</span></div>`,
        esc(row.recipientName),
        row.count.toLocaleString("ja-JP"),
        pts(row.points),
      ]),
      [2, 3],
    );
  }
  if (tab === "gifter") {
    return table(
      ["ギフティング者", "件数", "ギフト先", "主なスタンプ", "合計"],
      aggregate.byGifter.map((row) => [
        `<div class="name-cell">${row.avatar ? `<img class="avatar" src="${esc(row.avatar)}" alt="" />` : ""}<span>${esc(row.name)}</span></div>`,
        row.count.toLocaleString("ja-JP"),
        row.recipients.toLocaleString("ja-JP"),
        esc(row.topStamp),
        pts(row.points),
      ]),
      [1, 2, 4],
    );
  }
  if (tab === "stamp") {
    return table(
      ["スタンプ", "件数", "ギフティング者", "合計"],
      aggregate.byStamp.map((row) => [
        `<div class="name-cell">${row.image ? `<img class="stamp" src="${esc(row.image)}" alt="" />` : ""}<span>${esc(row.name)}</span></div>`,
        row.count.toLocaleString("ja-JP"),
        row.gifters.toLocaleString("ja-JP"),
        pts(row.points),
      ]),
      [1, 2, 3],
    );
  }
  return table(
    ["日時", "ギフティング者", "ギフト先", "スタンプ", "ポイント"],
    aggregate.rows.map((row) => [
      fmt(row.createdAt),
      esc(row.gifterName),
      esc(row.recipientName),
      `<div class="name-cell">${row.stampImage ? `<img class="stamp" src="${esc(row.stampImage)}" alt="" />` : ""}<span>${esc(row.stampName)}</span></div>`,
      pts(row.points),
    ]),
    [4],
  );
}

function table(headers, rows, numericIndexes = []) {
  const numeric = new Set(numericIndexes.length ? numericIndexes : headers.map((_, index) => index).filter((index) => index > 0));
  return `<table>
    <thead><tr>${headers.map((header, index) => `<th class="${numeric.has(index) ? "num" : ""}">${esc(header)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, index) => `<td class="${numeric.has(index) ? "num" : ""}">${cell}</td>`)
              .join("")}</tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}
