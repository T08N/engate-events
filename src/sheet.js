import { crc32 } from "node:zlib";

const GOLD = "FFF5C542";
const SILVER = "FFC5CDD6";
const BRONZE = "FFE0A36A";

const HEADERS = ["チーム名", "イベント名", "状態", "開始", "終了", "年", "ギフティング総額（PT）", "ギフティング人数", "イベントURL", "コミュニティURL"];

function xml(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

function tokyoParts(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function tokyoText(iso) {
  const parts = tokyoParts(iso);
  if (!parts) return "";
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function statusLabel(status) {
  if (status === "open") return "開催中";
  if (status === "upcoming") return "開催予定";
  return "終了";
}

export function sortEvents(events, key) {
  const metric = key === "people" || key === "start" ? key : "points";
  const valueOf = (event, name) => {
    if (name === "people") return event.ranking ? Number(event.ranking.count) || 0 : null;
    if (name === "start") return event.startedAt || null;
    return event.ranking ? Number(event.ranking.totalPoint) || 0 : null;
  };
  const tie = metric === "people" ? "points" : "people";
  return [...events].sort((a, b) => {
    const av = valueOf(a, metric);
    const bv = valueOf(b, metric);
    if ((av == null) !== (bv == null)) return av == null ? 1 : -1;
    if (av !== bv) return typeof av === "number" ? bv - av : String(bv).localeCompare(String(av));
    const at = valueOf(a, tie);
    const bt = valueOf(b, tie);
    if ((at == null) !== (bt == null)) return at == null ? 1 : -1;
    if (at !== bt) return typeof at === "number" ? bt - at : String(bt).localeCompare(String(at));
    return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
  });
}

function sortLabel(key) {
  if (key === "people") return "ギフティング人数の多い順";
  if (key === "start") return "開始日の新しい順";
  return "ギフティング総額の多い順";
}

function medalIndexes(events) {
  const amounts = [...new Set(events.map((event) => (event.ranking ? Number(event.ranking.totalPoint) || 0 : 0)).filter((value) => value > 0))].sort(
    (a, b) => b - a,
  );
  return new Map(amounts.slice(0, 3).map((value, index) => [value, index]));
}

function colName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function formulaLiteral(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll('"', '""')
    .replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}

function cellXml(ref, cell) {
  if (cell.kind === "link") {
    const target = formulaLiteral(cell.value);
    return `<c r="${ref}" s="6" t="str"><f>HYPERLINK("${target}","${target}")</f><v>${xml(cell.value)}</v></c>`;
  }
  if (cell.kind === "n") {
    return `<c r="${ref}" s="${cell.style || 2}"><v>${Number(cell.value) || 0}</v></c>`;
  }
  const style = cell.style ? ` s="${cell.style}"` : "";
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`;
}

function sheetXml(rows, widths, dataRows) {
  const lastCol = colName(Math.max(0, (rows[0]?.length || 1) - 1));
  const lastRow = Math.max(1, rows.length);
  const filterEnd = Math.min(lastRow, Math.max(1, dataRows || lastRow));
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, column) => (cell == null || cell.value == null || cell.value === "" ? "" : cellXml(`${colName(column)}${rowIndex + 1}`, cell)))
        .filter(Boolean)
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
  <autoFilter ref="A1:${lastCol}${filterEnd}"/>
</worksheet>`;
}

function headerRow(labels) {
  return labels.map((label) => ({ value: label, style: 1 }));
}

function eventRows(events) {
  const medals = medalIndexes(events);
  const medalStyle = [3, 4, 5];
  return events.map((event) => {
    const total = event.ranking ? Number(event.ranking.totalPoint) || 0 : null;
    const people = event.ranking ? Number(event.ranking.count) || 0 : null;
    const started = tokyoParts(event.startedAt);
    const medal = total > 0 ? medals.get(total) : undefined;
    return [
      { value: event.community?.name || event.slug || "" },
      { value: event.title || "" },
      { value: statusLabel(event.status) },
      { value: tokyoText(event.startedAt) },
      { value: tokyoText(event.endedAt) },
      started ? { value: started.year } : { value: "" },
      total == null ? { value: "" } : { value: total, kind: "n", style: medal == null ? 2 : medalStyle[medal] },
      people == null ? { value: "" } : { value: people, kind: "n", style: 2 },
      event.url ? { value: event.url, kind: "link" } : { value: "" },
      event.community ? { value: `https://engate.jp/communities/${event.slug}/`, kind: "link" } : { value: "" },
    ];
  });
}

const WIDTHS = [28, 54, 12, 18, 18, 8, 24, 16, 62, 46];

function eventSheet(name, events, sort) {
  const rows = [headerRow(HEADERS), ...eventRows(events)];
  const total = events.reduce((sum, event) => sum + (event.ranking ? Number(event.ranking.totalPoint) || 0 : 0), 0);
  rows.push([
    { value: "合計", style: 8 },
    { value: `${events.length}件 / ${sortLabel(sort)}`, style: 8 },
    { value: "" },
    { value: "" },
    { value: "" },
    { value: "" },
    { value: total, kind: "n", style: 7 },
    { value: "" },
    { value: "" },
    { value: "" },
  ]);
  rows.push([{ value: "金・銀・銅は、この表のギフティング総額の上位3件です。" }]);
  return { name, rows, widths: WIDTHS, dataRows: events.length + 1 };
}

function summarySheet(groups, sort) {
  const headers = ["季節", "件数", "ギフティング総額（PT）", "総額1位のイベント", "1位の総額（PT）", "1位の人数", "1位のURL"];
  const totals = groups.map((group) => group.events.reduce((sum, event) => sum + (event.ranking ? Number(event.ranking.totalPoint) || 0 : 0), 0));
  const ranked = [...new Set(totals.filter((value) => value > 0))].sort((a, b) => b - a).slice(0, 3);
  const medalStyle = [3, 4, 5];
  const rows = [
    headerRow(headers),
    ...groups.map((group, index) => {
      const best = [...group.events].sort(
        (a, b) => (b.ranking?.totalPoint || 0) - (a.ranking?.totalPoint || 0) || String(b.startedAt || "").localeCompare(String(a.startedAt || "")),
      )[0];
      const medal = ranked.indexOf(totals[index]);
      return [
        { value: group.name },
        { value: group.events.length, kind: "n", style: 2 },
        { value: totals[index], kind: "n", style: medal >= 0 ? medalStyle[medal] : 2 },
        { value: best?.title || "" },
        best?.ranking ? { value: Number(best.ranking.totalPoint) || 0, kind: "n", style: 2 } : { value: "" },
        best?.ranking ? { value: Number(best.ranking.count) || 0, kind: "n", style: 2 } : { value: "" },
        best?.url ? { value: best.url, kind: "link" } : { value: "" },
      ];
    }),
    [
      { value: "合計", style: 8 },
      { value: groups.reduce((sum, group) => sum + group.events.length, 0), kind: "n", style: 7 },
      { value: totals.reduce((sum, value) => sum + value, 0), kind: "n", style: 7 },
      { value: sortLabel(sort), style: 8 },
      { value: "" },
      { value: "" },
      { value: "" },
    ],
    [{ value: "各季節シートは画面で選んだ順です。金・銀・銅はギフティング総額の上位3件です。" }],
  ];
  return { name: "まとめ", rows, widths: [16, 12, 24, 54, 18, 14, 62], dataRows: groups.length + 1 };
}

export function workbookForGroups(groups, sort) {
  const sheets = [];
  if (groups.length > 1) sheets.push(summarySheet(groups, sort));
  for (const group of groups) sheets.push(eventSheet(sheetName(group.name), group.events, sort));
  return buildXlsx(sheets);
}

function sheetName(name) {
  const cleaned = String(name || "イベント").replace(/[\\/*?:[\]]/g, " ").trim() || "イベント";
  return [...cleaned].slice(0, 31).join("");
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
  <fonts count="4">
    <font><sz val="11"/><name val="游ゴシック"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="游ゴシック"/></font>
    <font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="游ゴシック"/></font>
    <font><b/><sz val="11"/><name val="游ゴシック"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${GOLD}"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${SILVER}"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${BRONZE}"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F0FE"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="9">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="3" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="164" fontId="3" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="3" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypes(count) {
  const sheets = Array.from({ length: count }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets}
</Types>`;
}

function workbookXml(sheets) {
  const list = sheets
    .map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${list}</sheets>
</workbook>`;
}

function workbookRels(count) {
  const sheets = Array.from(
    { length: count },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets}
  <Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildXlsx(sheets) {
  const files = [
    ["[Content_Types].xml", contentTypes(sheets.length)],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ["xl/workbook.xml", workbookXml(sheets)],
    ["xl/_rels/workbook.xml.rels", workbookRels(sheets.length)],
    ["xl/styles.xml", stylesXml()],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows, sheet.widths, sheet.dataRows)]),
  ];
  return zipStored(files.map(([name, text]) => [name, Buffer.from(text, "utf8")]));
}

function zipStored(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const fileName = Buffer.from(name, "utf8");
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + fileName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    fileName.copy(local, 30);
    locals.push(local, data);
    const central = Buffer.alloc(46 + fileName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    fileName.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}
