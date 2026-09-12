"use strict";

/* ================= 常量 ================= */

const STORAGE_KEY = "film-reel-desk.v2";
const LEGACY_KEY = "zfl17-film-strip-desk";
const TRASH_LIMIT = 20;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_SEC = 24 * 3600;
const REEL_LENGTH_WARN_SEC = 3600;
const THUMB_MAX_EDGE = 360;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];

const SHIFT_OPTIONS = ["正常", "偏红", "偏青", "偏黄", "褪色", "严重褪色"];
const DAMAGE_OPTIONS = ["完好", "轻微划痕", "接片松动", "齿孔破损", "片基脆化", "霉变", "需跳过"];

// 0 = 正常，1 = 需留意，2 = 高风险
const SHIFT_RISK = { 正常: 0, 偏红: 1, 偏青: 1, 偏黄: 1, 褪色: 1, 严重褪色: 2 };
const DAMAGE_RISK = { 完好: 0, 轻微划痕: 1, 接片松动: 1, 齿孔破损: 2, 片基脆化: 2, 霉变: 2, 需跳过: 2 };

const FALLBACK_THUMBS = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

/* ================= 状态 ================= */

let state = loadState();
let editingId = null;       // 正在编辑的片段 id；null 表示新增模式
let editThumb = "";         // 编辑模式下当前的缩略图（可能被移除）
let draggedId = null;
let toastTimer = null;

const els = {
  statCount: document.querySelector("#statCount"),
  statDuration: document.querySelector("#statDuration"),
  statRisk: document.querySelector("#statRisk"),
  statNotice: document.querySelector("#statNotice"),
  reelSelect: document.querySelector("#reelSelect"),
  newReelBtn: document.querySelector("#newReelBtn"),
  deleteReelBtn: document.querySelector("#deleteReelBtn"),
  restoreBtn: document.querySelector("#restoreBtn"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  importJsonBtn: document.querySelector("#importJsonBtn"),
  importFileInput: document.querySelector("#importFileInput"),
  reelName: document.querySelector("#reelName"),
  reelNote: document.querySelector("#reelNote"),
  colorFilter: document.querySelector("#colorFilter"),
  damageFilter: document.querySelector("#damageFilter"),
  searchInput: document.querySelector("#searchInput"),
  clearFilterBtn: document.querySelector("#clearFilterBtn"),
  filterInfo: document.querySelector("#filterInfo"),
  formTitle: document.querySelector("#formTitle"),
  formErrors: document.querySelector("#formErrors"),
  segmentForm: document.querySelector("#segmentForm"),
  codeInput: document.querySelector("#codeInput"),
  durationInput: document.querySelector("#durationInput"),
  shiftInput: document.querySelector("#shiftInput"),
  damageInput: document.querySelector("#damageInput"),
  thumbInput: document.querySelector("#thumbInput"),
  thumbPreviewWrap: document.querySelector("#thumbPreviewWrap"),
  thumbPreview: document.querySelector("#thumbPreview"),
  removeThumbBtn: document.querySelector("#removeThumbBtn"),
  noteInput: document.querySelector("#noteInput"),
  submitBtn: document.querySelector("#submitBtn"),
  cancelEditBtn: document.querySelector("#cancelEditBtn"),
  segmentList: document.querySelector("#segmentList"),
  orderHint: document.querySelector("#orderHint"),
  riskSummary: document.querySelector("#riskSummary"),
  warningList: document.querySelector("#warningList"),
  toast: document.querySelector("#toast")
};

/* ================= 工具 ================= */

function uid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 接受 "95"、"1:35"、"1:05:20"；返回正整数秒，非法返回 null
function parseDuration(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,6}(:\d{1,2}){0,2}$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] > 59) return null;
  }
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_DURATION_SEC) return null;
  return sec;
}

function segmentRisk(segment) {
  return Math.max(SHIFT_RISK[segment.shift] ?? 0, DAMAGE_RISK[segment.damage] ?? 0);
}

function riskLabel(risk) {
  return risk === 2 ? "高风险" : risk === 1 ? "留意" : "—";
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeFileName(name) {
  const cleaned = String(name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "未命名";
}

function downloadFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* ================= 持久化 ================= */

function seedState() {
  return {
    version: 2,
    currentReelId: null,
    reels: [
      {
        id: uid(),
        name: "示例卷 · 春日试映A",
        note: "示例数据，可直接删除本卷。",
        segments: [
          { id: uid(), code: "A-001", duration: 18, shift: "正常", damage: "完好", note: "开场街景，节奏平稳。", thumb: "" },
          { id: uid(), code: "A-006", duration: 9, shift: "偏红", damage: "轻微划痕", note: "人物近景左侧有划痕，试映时留意。", thumb: "" },
          { id: uid(), code: "A-012", duration: 14, shift: "褪色", damage: "接片松动", note: "接片位置靠近段尾，放映前建议重新压平。", thumb: "" }
        ]
      }
    ],
    trash: []
  };
}

function normalizeReel(raw) {
  const reel = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof reel.id === "string" && reel.id ? reel.id : uid(),
    name: typeof reel.name === "string" ? reel.name : "未命名卷",
    note: typeof reel.note === "string" ? reel.note : "",
    segments: Array.isArray(reel.segments) ? reel.segments.map(normalizeSegment) : []
  };
}

function normalizeSegment(raw) {
  const seg = raw && typeof raw === "object" ? raw : {};
  return {
    id: typeof seg.id === "string" && seg.id ? seg.id : uid(),
    code: typeof seg.code === "string" ? seg.code : "",
    duration: Number.isFinite(Number(seg.duration)) && Number(seg.duration) > 0 ? Math.round(Number(seg.duration)) : 1,
    shift: SHIFT_OPTIONS.includes(seg.shift) ? seg.shift : "正常",
    damage: DAMAGE_OPTIONS.includes(seg.damage) ? seg.damage : "完好",
    note: typeof seg.note === "string" ? seg.note : "",
    thumb: typeof seg.thumb === "string" ? seg.thumb : ""
  };
}

function loadState() {
  let parsed = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) parsed = JSON.parse(saved);
  } catch {
    parsed = null;
  }

  // 兼容旧版本单卷数据，迁移为多卷结构
  if (!parsed) {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const old = JSON.parse(legacy);
        if (old && Array.isArray(old.segments)) {
          parsed = {
            version: 2,
            reels: [{ id: uid(), name: old.reelTitle || "迁移的胶片卷", note: "", segments: old.segments }],
            currentReelId: null,
            trash: []
          };
        }
      }
    } catch {
      parsed = null;
    }
  }

  if (!parsed || !Array.isArray(parsed.reels)) parsed = seedState();
  parsed.reels = parsed.reels.map(normalizeReel);
  if (parsed.reels.length === 0) parsed.reels = seedState().reels;
  if (!Array.isArray(parsed.trash)) parsed.trash = [];
  parsed.trash = parsed.trash.slice(0, TRASH_LIMIT);
  if (!parsed.reels.some((reel) => reel.id === parsed.currentReelId)) {
    parsed.currentReelId = parsed.reels[0].id;
  }
  return parsed;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    toast("保存失败：浏览器本地存储空间不足，建议先「备份全部数据」再清理缩略图。");
  }
}

function currentReel() {
  return state.reels.find((reel) => reel.id === state.currentReelId) || state.reels[0];
}

function reelDisplayName(reel) {
  return String(reel.name || "").trim() || "未命名卷";
}

/* ================= 提示条 ================= */

function toast(message, action) {
  clearTimeout(toastTimer);
  els.toast.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = message;
  els.toast.appendChild(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      hideToast();
      action.onClick();
    });
    els.toast.appendChild(btn);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭提示");
  close.addEventListener("click", hideToast);
  els.toast.appendChild(close);
  els.toast.hidden = false;
  toastTimer = setTimeout(hideToast, action ? 8000 : 4500);
}

function hideToast() {
  clearTimeout(toastTimer);
  els.toast.hidden = true;
}

/* ================= 渲染 ================= */

function fillSelect(select, options, allLabel) {
  select.innerHTML = "";
  if (allLabel) {
    const opt = document.createElement("option");
    opt.value = "all";
    opt.textContent = allLabel;
    select.appendChild(opt);
  }
  for (const value of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

function isFiltering() {
  return (
    els.colorFilter.value !== "all" ||
    els.damageFilter.value !== "all" ||
    els.searchInput.value.trim() !== ""
  );
}

function getFilteredSegments() {
  const reel = currentReel();
  const color = els.colorFilter.value;
  const damage = els.damageFilter.value;
  const keyword = els.searchInput.value.trim().toLowerCase();
  return reel.segments.filter((item) => {
    const matchesColor = color === "all" || item.shift === color;
    const matchesDamage = damage === "all" || item.damage === damage;
    const matchesKeyword =
      !keyword ||
      item.code.toLowerCase().includes(keyword) ||
      item.note.toLowerCase().includes(keyword);
    return matchesColor && matchesDamage && matchesKeyword;
  });
}

function renderReelBar() {
  const reel = currentReel();
  els.reelSelect.innerHTML = state.reels
    .map((r) => `<option value="${r.id}">${escapeHtml(reelDisplayName(r))}（${r.segments.length} 段）</option>`)
    .join("");
  els.reelSelect.value = reel.id;
  if (els.reelName.value !== reel.name) els.reelName.value = reel.name;
  if (els.reelNote.value !== reel.note) els.reelNote.value = reel.note;

  const latest = state.trash[0];
  els.restoreBtn.disabled = !latest;
  els.restoreBtn.textContent = latest ? `↩ 恢复最近删除（${state.trash.length}）` : "↩ 恢复最近删除";
  els.restoreBtn.title = latest
    ? latest.type === "segment"
      ? `恢复片段「${latest.segment.code}」到「${latest.reelName}」`
      : `恢复胶片卷「${reelDisplayName(latest.reel)}」（含 ${latest.reel.segments.length} 段）`
    : "最近没有删除记录";
}

function renderStats() {
  const reel = currentReel();
  const total = reel.segments.reduce((sum, item) => sum + item.duration, 0);
  const risks = reel.segments.map(segmentRisk);
  els.statCount.textContent = reel.segments.length;
  els.statDuration.textContent = formatDuration(total);
  els.statRisk.textContent = risks.filter((r) => r === 2).length;
  els.statNotice.textContent = risks.filter((r) => r === 1).length;
}

function renderList() {
  const reel = currentReel();
  const filtering = isFiltering();
  const segments = getFilteredSegments();

  els.filterInfo.textContent = filtering ? `显示 ${segments.length} / 共 ${reel.segments.length} 段` : "";
  els.orderHint.textContent = filtering ? "筛选状态下不可排序，清除筛选后可调整" : "拖拽卡片或点 ↑ ↓ 调整顺序";

  if (reel.segments.length === 0) {
    els.segmentList.innerHTML = `<p class="empty">本卷还没有片段，从左侧「录入片段」开始。</p>`;
    return;
  }
  if (segments.length === 0) {
    els.segmentList.innerHTML = `<p class="empty">没有符合筛选条件的片段。</p>`;
    return;
  }

  els.segmentList.innerHTML = segments
    .map((item) => {
      const realIndex = reel.segments.findIndex((seg) => seg.id === item.id);
      const risk = segmentRisk(item);
      const riskTag =
        risk === 2
          ? `<span class="tag risk-high">高风险</span>`
          : risk === 1
            ? `<span class="tag risk-notice">留意</span>`
            : "";
      return `
        <article class="segment-card" draggable="${filtering ? "false" : "true"}" data-id="${item.id}">
          <div class="thumb">
            ${
              item.thumb
                ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)} 缩略图" />`
                : `<div class="film-placeholder" style="background:${FALLBACK_THUMBS[realIndex % FALLBACK_THUMBS.length]}">${escapeHtml(item.code)}</div>`
            }
          </div>
          <div class="segment-main">
            <div class="segment-title">
              <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
              <span>${formatDuration(item.duration)}</span>
            </div>
            <div class="tag-row">
              <span class="tag">${escapeHtml(item.shift)}</span>
              <span class="tag ${item.damage !== "完好" ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
              ${riskTag}
            </div>
            <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
          </div>
          <div class="segment-actions">
            <button type="button" title="上移" data-move-up="${item.id}" ${filtering ? "disabled" : ""}>↑</button>
            <button type="button" title="下移" data-move-down="${item.id}" ${filtering ? "disabled" : ""}>↓</button>
            <button type="button" title="编辑" data-edit="${item.id}">✎</button>
            <button type="button" title="删除" data-delete="${item.id}">×</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderWarnings() {
  const reel = currentReel();
  const total = reel.segments.reduce((sum, item) => sum + item.duration, 0);

  const summaryParts = [];
  if (total > REEL_LENGTH_WARN_SEC) {
    summaryParts.push(
      `<div class="warning-item reel-warn"><strong>片长提醒</strong><span>本卷总时长 ${formatDuration(total)}，超过 ${formatDuration(REEL_LENGTH_WARN_SEC)}，注意换卷与片盒容量。</span></div>`
    );
  }
  els.riskSummary.innerHTML = summaryParts.join("");

  const risky = reel.segments
    .map((item, index) => ({ item, index, risk: segmentRisk(item) }))
    .filter((entry) => entry.risk > 0);

  els.warningList.innerHTML =
    risky
      .map(({ item, index, risk }) => {
        const reasons = [
          item.shift !== "正常" ? item.shift : "",
          item.damage !== "完好" ? item.damage : ""
        ]
          .filter(Boolean)
          .join(" · ");
        return `
          <div class="warning-item ${risk === 2 ? "high" : ""}">
            <strong>${index + 1}. ${escapeHtml(item.code)}<span class="warning-level">${riskLabel(risk)}</span></strong>
            <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
          </div>
        `;
      })
      .join("") || `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`;
}

function renderAll() {
  saveState();
  renderReelBar();
  renderStats();
  renderList();
  renderWarnings();
}

/* ================= 表单：录入与编辑 ================= */

function showErrors(errors) {
  els.formErrors.innerHTML = errors.map((msg) => `<p>⚠ ${escapeHtml(msg)}</p>`).join("");
  els.formErrors.hidden = false;
}

function clearErrors() {
  els.formErrors.innerHTML = "";
  els.formErrors.hidden = true;
}

function resetForm() {
  editingId = null;
  editThumb = "";
  els.segmentForm.reset();
  els.formTitle.textContent = "录入片段";
  els.submitBtn.textContent = "加入清单";
  els.cancelEditBtn.hidden = true;
  els.thumbPreviewWrap.hidden = true;
  els.thumbPreview.removeAttribute("src");
  clearErrors();
}

function startEdit(id) {
  const reel = currentReel();
  const segment = reel.segments.find((item) => item.id === id);
  if (!segment) return;
  editingId = id;
  editThumb = segment.thumb;
  els.codeInput.value = segment.code;
  els.durationInput.value = String(segment.duration);
  els.shiftInput.value = segment.shift;
  els.damageInput.value = segment.damage;
  els.noteInput.value = segment.note;
  els.thumbInput.value = "";
  if (segment.thumb) {
    els.thumbPreview.src = segment.thumb;
    els.thumbPreviewWrap.hidden = false;
  } else {
    els.thumbPreviewWrap.hidden = true;
  }
  els.formTitle.textContent = `编辑片段 ${segment.code}`;
  els.submitBtn.textContent = "保存修改";
  els.cancelEditBtn.hidden = false;
  clearErrors();
  els.codeInput.focus();
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const typeOk = IMAGE_TYPES.includes(file.type) || (file.type === "" && IMAGE_EXTS.includes(ext));
    if (!typeOk) {
      reject(new Error(`图片格式不支持（${file.name}）：仅接受 PNG / JPG / WebP / GIF`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`图片超过 2MB（${(file.size / 1024 / 1024).toFixed(1)}MB），请先压缩后再上传`));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        reject(new Error("缩略图生成失败，请更换图片"));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`图片无法解码（${file.name}），文件可能损坏或并非有效图片`));
    };
    img.src = url;
  });
}

async function onSubmitSegment(event) {
  event.preventDefault();
  clearErrors();
  els.submitBtn.disabled = true;
  try {
    const reel = currentReel();
    const errors = [];

    const code = els.codeInput.value.trim();
    if (!code) {
      errors.push("片段编号不能为空。");
    } else {
      const duplicated = reel.segments.some(
        (item) => item.id !== editingId && item.code.trim().toLowerCase() === code.toLowerCase()
      );
      if (duplicated) errors.push(`编号「${code}」在本卷中已存在，请更换编号。`);
    }

    const duration = parseDuration(els.durationInput.value);
    if (duration === null) {
      errors.push("时长需为 1 秒到 24 小时之间：可填秒数（如 95）或 分:秒（如 1:35）。");
    }

    let thumb = editingId ? editThumb : "";
    const file = els.thumbInput.files[0];
    if (file) {
      try {
        thumb = await processImageFile(file);
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (errors.length > 0) {
      showErrors(errors);
      return; // 校验未通过，不写入清单
    }

    if (editingId) {
      const target = reel.segments.find((item) => item.id === editingId);
      if (!target) {
        resetForm();
        return;
      }
      target.code = code;
      target.duration = duration;
      target.shift = els.shiftInput.value;
      target.damage = els.damageInput.value;
      target.note = els.noteInput.value.trim();
      target.thumb = thumb;
      toast(`已保存片段 ${code}`);
    } else {
      reel.segments.push({
        id: uid(),
        code,
        duration,
        shift: els.shiftInput.value,
        damage: els.damageInput.value,
        note: els.noteInput.value.trim(),
        thumb
      });
      toast(`已加入片段 ${code}`);
    }
    resetForm();
    renderAll();
  } finally {
    els.submitBtn.disabled = false;
  }
}

/* ================= 排序 ================= */

function moveSegment(id, direction) {
  const reel = currentReel();
  const index = reel.segments.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= reel.segments.length) return;
  const [item] = reel.segments.splice(index, 1);
  reel.segments.splice(target, 0, item);
  renderAll();
}

function getDragAfterElement(container, y) {
  return [...container.querySelectorAll(".segment-card:not(.dragging)")].reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      return offset < 0 && offset > closest.offset ? { offset, element: child } : closest;
    },
    { offset: -Infinity, element: null }
  ).element;
}

function clearDropIndicators() {
  els.segmentList.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

/* ================= 删除与恢复 ================= */

function pushTrash(entry) {
  state.trash.unshift(entry);
  state.trash = state.trash.slice(0, TRASH_LIMIT);
}

function deleteSegment(id) {
  const reel = currentReel();
  const index = reel.segments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [segment] = reel.segments.splice(index, 1);
  if (editingId === id) resetForm();
  pushTrash({ type: "segment", reelId: reel.id, reelName: reelDisplayName(reel), index, segment, deletedAt: Date.now() });
  renderAll();
  toast(`已删除片段 ${segment.code}`, { label: "立即恢复", onClick: restoreLastDeleted });
}

function deleteCurrentReel() {
  const reel = currentReel();
  const ok = window.confirm(
    `确定删除胶片卷「${reelDisplayName(reel)}」吗？\n卷内 ${reel.segments.length} 个片段将一并移除，可通过「恢复最近删除」找回。`
  );
  if (!ok) return;
  const index = state.reels.findIndex((item) => item.id === reel.id);
  state.reels.splice(index, 1);
  pushTrash({ type: "reel", index, reel, deletedAt: Date.now() });
  if (state.reels.length === 0) {
    state.reels.push({ id: uid(), name: "未命名卷 1", note: "", segments: [] });
  }
  state.currentReelId = state.reels[Math.min(index, state.reels.length - 1)].id;
  resetForm();
  renderAll();
  toast(`已删除胶片卷「${reelDisplayName(reel)}」`, { label: "立即恢复", onClick: restoreLastDeleted });
}

function restoreLastDeleted() {
  const entry = state.trash.shift();
  if (!entry) {
    toast("最近没有可恢复的删除记录。");
    renderAll();
    return;
  }
  if (entry.type === "segment") {
    const reel = state.reels.find((item) => item.id === entry.reelId) || currentReel();
    const segment = normalizeSegment(entry.segment);
    const conflict = reel.segments.some((item) => item.code.trim().toLowerCase() === segment.code.trim().toLowerCase());
    if (conflict) segment.code = `${segment.code}-恢复`;
    reel.segments.splice(Math.min(entry.index, reel.segments.length), 0, segment);
    state.currentReelId = reel.id;
    toast(conflict ? `已恢复片段，因编号重复改名为「${segment.code}」` : `已恢复片段 ${segment.code} 到「${reelDisplayName(reel)}」`);
  } else {
    const reel = normalizeReel(entry.reel);
    if (state.reels.some((item) => item.id === reel.id)) reel.id = uid();
    state.reels.splice(Math.min(entry.index, state.reels.length), 0, reel);
    state.currentReelId = reel.id;
    toast(`已恢复胶片卷「${reelDisplayName(reel)}」（${reel.segments.length} 段）`);
  }
  renderAll();
}

/* ================= 胶片卷管理 ================= */

function createReel() {
  let n = state.reels.length + 1;
  const names = new Set(state.reels.map((reel) => reel.name));
  while (names.has(`未命名卷 ${n}`)) n++;
  const reel = { id: uid(), name: `未命名卷 ${n}`, note: "", segments: [] };
  state.reels.push(reel);
  state.currentReelId = reel.id;
  resetForm();
  renderAll();
  els.reelName.focus();
  els.reelName.select();
  toast(`已新建「${reel.name}」，可在上方直接改名`);
}

function switchReel(id) {
  if (!state.reels.some((reel) => reel.id === id)) return;
  state.currentReelId = id;
  resetForm();
  renderAll();
}

/* ================= 导出与导入 ================= */

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function exportCsv() {
  const reel = currentReel();
  if (reel.segments.length === 0) {
    toast("本卷还没有片段，无可导出的试映清单。");
    return;
  }
  const header = ["顺序", "编号", "时长(秒)", "时长", "颜色偏移", "破损情况", "风险", "备注"];
  const rows = reel.segments.map((item, index) => [
    index + 1,
    item.code,
    item.duration,
    formatDuration(item.duration),
    item.shift,
    item.damage,
    riskLabel(segmentRisk(item)),
    item.note
  ]);
  const csv = "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(`试映清单-${safeFileName(reel.name)}-${fileStamp()}.csv`, csv, "text/csv;charset=utf-8");
  toast(`已导出试映清单（${reel.segments.length} 段）`);
}

function exportJson() {
  const payload = {
    app: "film-reel-desk",
    version: 2,
    exportedAt: new Date().toISOString(),
    reels: state.reels
  };
  downloadFile(`胶片核对台备份-${fileStamp()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  toast(`已备份全部 ${state.reels.length} 个胶片卷`);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      toast("导入失败：文件不是有效的 JSON。");
      return;
    }
    const reels = parsed && Array.isArray(parsed.reels) ? parsed.reels : Array.isArray(parsed) ? parsed : null;
    if (!reels || reels.length === 0) {
      toast("导入失败：备份文件中没有胶片卷数据。");
      return;
    }
    const ok = window.confirm(`导入将覆盖当前全部数据（${reels.length} 个胶片卷），确定继续吗？\n建议先「备份全部数据」。`);
    if (!ok) return;
    state.reels = reels.map(normalizeReel);
    state.currentReelId = state.reels[0].id;
    resetForm();
    renderAll();
    toast(`已导入 ${state.reels.length} 个胶片卷`);
  };
  reader.onerror = () => toast("导入失败：无法读取文件。");
  reader.readAsText(file);
}

/* ================= 事件绑定 ================= */

function init() {
  fillSelect(els.shiftInput, SHIFT_OPTIONS);
  fillSelect(els.damageInput, DAMAGE_OPTIONS);
  fillSelect(els.colorFilter, SHIFT_OPTIONS, "全部");
  fillSelect(els.damageFilter, DAMAGE_OPTIONS, "全部");

  els.reelSelect.addEventListener("change", () => switchReel(els.reelSelect.value));
  els.newReelBtn.addEventListener("click", createReel);
  els.deleteReelBtn.addEventListener("click", deleteCurrentReel);
  els.restoreBtn.addEventListener("click", restoreLastDeleted);
  els.exportCsvBtn.addEventListener("click", exportCsv);
  els.exportJsonBtn.addEventListener("click", exportJson);
  els.importJsonBtn.addEventListener("click", () => els.importFileInput.click());
  els.importFileInput.addEventListener("change", () => {
    const file = els.importFileInput.files[0];
    if (file) importJson(file);
    els.importFileInput.value = "";
  });

  els.reelName.addEventListener("input", () => {
    currentReel().name = els.reelName.value;
    saveState();
    renderReelBar();
  });
  els.reelName.addEventListener("blur", () => {
    if (!els.reelName.value.trim()) {
      currentReel().name = "未命名卷";
      renderReelBar();
    }
  });
  els.reelNote.addEventListener("input", () => {
    currentReel().note = els.reelNote.value;
    saveState();
  });

  els.colorFilter.addEventListener("change", renderList);
  els.damageFilter.addEventListener("change", renderList);
  els.searchInput.addEventListener("input", renderList);
  els.clearFilterBtn.addEventListener("click", () => {
    els.colorFilter.value = "all";
    els.damageFilter.value = "all";
    els.searchInput.value = "";
    renderList();
  });

  els.segmentForm.addEventListener("submit", onSubmitSegment);
  els.cancelEditBtn.addEventListener("click", resetForm);
  els.removeThumbBtn.addEventListener("click", () => {
    editThumb = "";
    els.thumbInput.value = "";
    els.thumbPreviewWrap.hidden = true;
  });

  els.segmentList.addEventListener("click", (event) => {
    const up = event.target.closest("[data-move-up]");
    const down = event.target.closest("[data-move-down]");
    const edit = event.target.closest("[data-edit]");
    const del = event.target.closest("[data-delete]");
    if (up) moveSegment(up.dataset.moveUp, -1);
    if (down) moveSegment(down.dataset.moveDown, 1);
    if (edit) startEdit(edit.dataset.edit);
    if (del) deleteSegment(del.dataset.delete);
  });

  els.segmentList.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".segment-card");
    if (!card || isFiltering()) return;
    draggedId = card.dataset.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedId);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });

  els.segmentList.addEventListener("dragover", (event) => {
    if (!draggedId || isFiltering()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropIndicators();
    const after = getDragAfterElement(els.segmentList, event.clientY);
    if (after) {
      after.classList.add("drop-before");
    } else {
      const cards = els.segmentList.querySelectorAll(".segment-card:not(.dragging)");
      cards[cards.length - 1]?.classList.add("drop-after");
    }
  });

  els.segmentList.addEventListener("drop", (event) => {
    if (!draggedId || isFiltering()) return;
    event.preventDefault();
    const reel = currentReel();
    const fromIndex = reel.segments.findIndex((item) => item.id === draggedId);
    if (fromIndex < 0) return;
    const after = getDragAfterElement(els.segmentList, event.clientY);
    const [item] = reel.segments.splice(fromIndex, 1);
    if (!after) {
      reel.segments.push(item);
    } else {
      const toIndex = reel.segments.findIndex((seg) => seg.id === after.dataset.id);
      reel.segments.splice(toIndex < 0 ? reel.segments.length : toIndex, 0, item);
    }
    draggedId = null;
    clearDropIndicators();
    renderAll();
  });

  els.segmentList.addEventListener("dragend", () => {
    draggedId = null;
    clearDropIndicators();
    els.segmentList.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  });

  renderAll();
}

init();
