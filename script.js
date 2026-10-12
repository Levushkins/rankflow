/**
 * RANKFLOW — Клиентская логика для подготовки доказательств и интеграции с Image Chest API v1
 * 
 * Правило: ОДИН КРИТЕРИЙ = ОДИН IMAGE CHEST POST = ОДНА ССЫЛКА (https://imgchest.com/p/{POST_ID}).
 * Локальная работа, поддержка file://, Drag & Drop, Ctrl+V, пакетной загрузки.
 */

(function () {
  "use strict";

  // Функция определения темы при первом заходе (из prefers-color-scheme)
  function getInitialTheme() {
    const saved = localStorage.getItem("rankflow_theme");
    if (saved === "light" || saved === "dark" || saved === "auto") {
      return saved;
    }
    return "auto";
  }

  // Дата в формате ДД.ММ.ГГГГ
  function getTodayDateString() {
    const d = new Date();
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  const UPLOAD_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;

  // Enter/Space на дропзоне = клик (дропзона — это role="button")
  function bindKeyboardClick(el) {
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.click();
      }
    });
  }

  // Зона перетаскивания: подсветка, фильтр изображений, без мигания на дочерних элементах
  function bindDropTarget(el, onEnter, onFiles) {
    let depth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (depth++ === 0) {
        el.classList.add("drag-over");
        onEnter();
      }
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    el.addEventListener("dragleave", () => {
      if (--depth <= 0) {
        depth = 0;
        el.classList.remove("drag-over");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      el.classList.remove("drag-over");
      const dt = e.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;
      const imageFiles = Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        onFiles(imageFiles);
      } else {
        showToast("Нужны изображения: PNG, JPG, WEBP", "amber");
      }
    });
  }

  // Миниатюра прикреплённого фото
  function previewItemHtml(item) {
    const labels = {
      pending: "",
      uploading: "Загрузка…",
      success: "✓",
      error: "Ошибка",
    };
    const tag = labels[item.status]
      ? `<span class="preview-status-tag status-${item.status}"${item.status === "error" ? ` title="${escapeHtml(item.errorMsg || "")}"` : ""}>${labels[item.status]}</span>`
      : "";
    const title = `${escapeHtml(item.name)} · ${formatBytes(item.size)}`;
    return `
      <img src="${item.objectUrl}" alt="${escapeHtml(item.name)}" title="${title}" loading="lazy">
      <button type="button" class="preview-remove-btn" title="Убрать" aria-label="Убрать ${escapeHtml(item.name)}">✕</button>
      ${tag}
    `;
  }

  // Результат загрузки: ссылка на пост или ошибка
  function postResultHtml(post, fallbackCount, ids) {
    if (post.uploaded && post.postUrl) {
      const count = post.imageCount || fallbackCount;
      const images = post.images || [];
      const shortUrl = post.postUrl.replace(/^https?:\/\//, "");
      return `
        <div class="post-result">
          <span class="post-status">✓ Загружено · ${count} ${getRussianImageWord(count)}</span>
          <a class="post-link" href="${post.postUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortUrl)}</a>
          <span class="post-actions">
            <button type="button" class="btn btn-ghost btn-sm" id="${ids.copy}">Копировать</button>
            <a class="btn btn-ghost btn-sm" href="${post.postUrl}" target="_blank" rel="noopener noreferrer">Открыть</a>
          </span>
          ${images.length > 0 ? `
            <details class="post-cdn">
              <summary>Прямые ссылки на изображения (${images.length})</summary>
              ${images.map((img, i) => `
                <div class="cdn-row">
                  <span>${i + 1}</span>
                  <a href="${img.link}" target="_blank" rel="noopener noreferrer">${escapeHtml(img.link)}</a>
                  <button type="button" class="btn btn-ghost btn-sm btn-copy-cdn" data-url="${img.link}">Копировать</button>
                </div>`).join("")}
            </details>` : ""}
        </div>
      `;
    }
    return `
      <div class="post-result is-error">
        <span class="post-status">Не загрузилось</span>
        <span class="post-actions"><button type="button" class="btn btn-secondary btn-sm" id="${ids.retry}">Повторить</button></span>
        <span class="post-error">${escapeHtml(post.error || "Неизвестная ошибка")}</span>
      </div>
    `;
  }

  // --- Хранилище состояния приложения ---
  const state = {
    activeTab: "promotion", // 'promotion' | 'sanctions' | 'settings'
    theme: getInitialTheme(),
    token: localStorage.getItem("rankflow_imgchest_token") || "",
    username: localStorage.getItem("rankflow_imgchest_username") || "",

    // Выбор в разделе "Повышение"
    promotion: {
      divisionId: "",
      rank: "",
      completion: {}, // { [criterionIdx]: boolean }
      files: {},      // { [criterionIdx]: Array<FileItem> }
      posts: {},      // { [criterionIdx]: { uploaded: boolean, postId: string, postUrl: string, imageCount: number, images: Array } }
      activeCriterionIdx: 0,
    },

    // Обязательные приложения: Ксерокопия паспорта и трудовой книжки
    documents: {
      passport: {
        files: [],
        post: null,
      },
      employment: {
        files: [],
        post: null,
      },
      activeDoc: null, // 'passport' | 'employment' | null
    },

    // Реквизиты для рапорта
    reportMeta: {
      position: localStorage.getItem("rankflow_report_pos") || "",
      rank: "",
      fio: localStorage.getItem("rankflow_report_fio") || "",
      signature: localStorage.getItem("rankflow_report_signature") || "",
      date: getTodayDateString(),
    },
    pendingDocUpload: null,

    // Выбор в разделе "Снятие взыскания"
    sanctions: {
      divisionId: "",
      rank: "",
      completion: {},
      files: {},
      posts: {},
      activeCriterionIdx: 0,
    },

    // Состояние текущей загрузки
    upload: {
      isUploading: false,
      totalCount: 0,
      currentCount: 0,
      hasErrors: false,
    },
  };

  // --- Элементы DOM ---
  const els = {
    // Навигация
    navPromotion: document.getElementById("nav-promotion"),
    navSanctions: document.getElementById("nav-sanctions"),
    navSettings: document.getElementById("nav-settings"),
    viewPromotion: document.getElementById("view-promotion"),
    viewSanctions: document.getElementById("view-sanctions"),
    viewSettings: document.getElementById("view-settings"),
    themeToggle: document.getElementById("theme-toggle"),
    apiStatusHeader: document.getElementById("api-status-header"),
    apiStatusDot: document.getElementById("api-status-dot"),
    apiStatusText: document.getElementById("api-status-text"),

    // Повышение
    promoWarning: document.getElementById("promo-warning"),
    promoDivisionSelect: document.getElementById("promo-division-select"),
    promoDivisionSubHint: document.getElementById("promo-division-sub-hint"),
    promoRankSelect: document.getElementById("promo-rank-select"),
    promoRankCard: document.getElementById("promo-rank-card"),
    promoCurrentRankVal: document.getElementById("promo-current-rank-val"),
    promoNextRankVal: document.getElementById("promo-next-rank-val"),
    promoRankDivisionText: document.getElementById("promo-rank-division-text"),
    promoProgressBar: document.getElementById("promo-progress-bar"),
    promoProgressFill: document.getElementById("promo-progress-fill"),
    promoProgressCount: document.getElementById("promo-progress-count"),
    promoResetBtn: document.getElementById("promo-reset-btn"),
    promoUploadAllBtn: document.getElementById("promo-upload-all-btn"),
    promoCriteriaList: document.getElementById("promo-criteria-list"),
    promoEmptyState: document.getElementById("promo-empty-state"),

    // Обязательные приложения (паспорт и трудовая книжка)
    promoDocsSection: document.getElementById("promo-docs-section"),
    cardDocPassport: document.getElementById("card-doc-passport"),
    cardDocEmployment: document.getElementById("card-doc-employment"),
    dropzoneDocPassport: document.getElementById("dropzone-doc-passport"),
    dropzoneDocEmployment: document.getElementById("dropzone-doc-employment"),
    fileInputDocPassport: document.getElementById("file-input-doc-passport"),
    fileInputDocEmployment: document.getElementById("file-input-doc-employment"),
    previewGridDocPassport: document.getElementById("preview-grid-doc-passport"),
    previewGridDocEmployment: document.getElementById("preview-grid-doc-employment"),
    resultsBoxDocPassport: document.getElementById("results-box-doc-passport"),
    resultsBoxDocEmployment: document.getElementById("results-box-doc-employment"),
    btnUploadDocPassport: document.getElementById("btn-upload-doc-passport"),
    btnUploadDocEmployment: document.getElementById("btn-upload-doc-employment"),
    countBadgeDocPassport: document.getElementById("count-badge-doc-passport"),
    countBadgeDocEmployment: document.getElementById("count-badge-doc-employment"),
    docPassportActiveTag: document.getElementById("doc-passport-active-tag"),
    docEmploymentActiveTag: document.getElementById("doc-employment-active-tag"),

    // Реквизиты рапорта
    promoReportMeta: document.getElementById("promo-report-meta"),
    reportPositionInput: document.getElementById("report-position-input"),
    reportRankInput: document.getElementById("report-rank-input"),
    reportFioInput: document.getElementById("report-fio-input"),
    reportDateInput: document.getElementById("report-date-input"),
    reportSignatureInput: document.getElementById("report-signature-input"),

    // Готовый рапорт в BBCode
    promoFinalReport: document.getElementById("promo-final-report"),
    reportReadinessBadge: document.getElementById("report-readiness-badge"),
    reportReadinessDot: document.getElementById("report-readiness-dot"),
    reportReadinessText: document.getElementById("report-readiness-text"),
    btnRefreshReport: document.getElementById("btn-refresh-report"),
    btnCopyReport: document.getElementById("btn-copy-report"),
    btnCopyReportMini: document.getElementById("btn-copy-report-mini"),
    reportChecklistBox: document.getElementById("report-checklist-box"),
    bbcodeOutputTextarea: document.getElementById("bbcode-output-textarea"),

    // Снятие взыскания
    sanctionWarning: document.getElementById("sanction-warning"),
    sanctionDivisionSelect: document.getElementById("sanction-division-select"),
    sanctionDivisionSubHint: document.getElementById("sanction-division-sub-hint"),
    sanctionRankSelect: document.getElementById("sanction-rank-select"),
    sanctionRankCard: document.getElementById("sanction-rank-card"),
    sanctionCurrentRankVal: document.getElementById("sanction-current-rank-val"),
    sanctionRankDivisionText: document.getElementById("sanction-rank-division-text"),
    sanctionProgressBar: document.getElementById("sanction-progress-bar"),
    sanctionProgressFill: document.getElementById("sanction-progress-fill"),
    sanctionProgressCount: document.getElementById("sanction-progress-count"),
    sanctionResetBtn: document.getElementById("sanction-reset-btn"),
    sanctionUploadAllBtn: document.getElementById("sanction-upload-all-btn"),
    sanctionCriteriaList: document.getElementById("sanction-criteria-list"),
    sanctionEmptyState: document.getElementById("sanction-empty-state"),

    // Индикатор Ctrl+V
    pasteIndicatorPill: document.getElementById("paste-indicator-pill"),
    pasteTargetTitle: document.getElementById("paste-target-title"),

    // Настройки Image Chest API
    imageChestTokenInput: document.getElementById("image-chest-token-input"),
    toggleTokenVisibilityBtn: document.getElementById("toggle-token-visibility-btn"),
    saveTokenBtn: document.getElementById("save-token-btn"),
    clearTokenBtn: document.getElementById("clear-token-btn"),
    imgchestStatusDot: document.getElementById("imgchest-status-dot"),
    imgchestStatusText: document.getElementById("imgchest-status-text"),
    imageChestStatusPill: document.getElementById("image-chest-status-pill"),
    themeSelect: document.getElementById("theme-select"),
    clearStorageBtn: document.getElementById("clear-storage-btn"),

    // Модальные окна
    confirmModal: document.getElementById("confirm-modal"),
    confirmModalSummary: document.getElementById("confirm-modal-summary"),
    confirmModalCancel: document.getElementById("confirm-modal-cancel"),
    confirmModalProceed: document.getElementById("confirm-modal-proceed"),

    docSecurityModal: document.getElementById("doc-security-modal"),
    docSecurityModalClose: document.getElementById("doc-security-modal-close"),
    docSecurityBtnCancel: document.getElementById("doc-security-btn-cancel"),
    docSecurityBtnProceed: document.getElementById("doc-security-btn-proceed"),
    docSecurityModalInfo: document.getElementById("doc-security-modal-info"),

    progressModal: document.getElementById("progress-modal"),
    progressModalTitle: document.getElementById("progress-modal-title"),
    progressModalSub: document.getElementById("progress-modal-sub"),
    progressModalFill: document.getElementById("progress-modal-fill"),
    progressModalCancel: document.getElementById("progress-modal-cancel"),

    toastContainer: document.getElementById("toast-container"),
  };

  // --- Инициализация приложения ---
  function init() {
    applyTheme(state.theme, false);

    // Слушатель системной темы при изменении настроек ОС
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        if (state.theme === "auto" || !localStorage.getItem("rankflow_theme")) {
          applyTheme("auto", false);
        }
      });
    }

    // Заполнение текстов предупреждений из официального источника
    if (window.CRITERIA_DATA) {
      if (els.promoWarning) {
        els.promoWarning.textContent = window.CRITERIA_DATA.generalWarningPromotion;
      }
      if (els.sanctionWarning) {
        els.sanctionWarning.textContent = window.CRITERIA_DATA.generalWarningSanctions;
      }
    }

    populateDivisionSelects();
    attachEventListeners();
    initDocumentsAndReport();

    // Восстановление токена и проверка подключения
    if (els.imageChestTokenInput) {
      els.imageChestTokenInput.value = state.token;
    }
    if (els.themeSelect) {
      els.themeSelect.value = state.theme;
    }

    if (state.token) {
      checkImageChestConnection(state.token);
    } else {
      updateApiStatusBadge(false, "Image Chest: нет токена");
      updateSettingsStatusPill(false, "Токен не указан — загрузка недоступна");
    }

    // Слушатель вставки изображений через Ctrl + V
    window.addEventListener("paste", handleGlobalPaste);

    // Клик по индикатору Ctrl+V прокручивает к активному критерию или документу
    if (els.pasteIndicatorPill) {
      els.pasteIndicatorPill.addEventListener("click", () => {
        const sectionName = state.activeTab;
        if (sectionName !== "promotion" && sectionName !== "sanctions") return;

        if (sectionName === "promotion" && state.documents && state.documents.activeDoc) {
          const docCard = state.documents.activeDoc === "passport" ? els.cardDocPassport : els.cardDocEmployment;
          if (docCard) {
            docCard.scrollIntoView({ behavior: "smooth", block: "center" });
            docCard.classList.add("is-paste-active");
          }
          return;
        }

        const activeIdx = state[sectionName].activeCriterionIdx || 0;
        const container = sectionName === "promotion" ? els.promoCriteriaList : els.sanctionCriteriaList;
        const targetCard = container ? container.children[activeIdx] : null;
        if (targetCard) {
          targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
          targetCard.classList.add("is-paste-active");
        }
      });
    }
  }

  // --- Управление темой ---
  function applyTheme(theme, save = true) {
    let effectiveTheme = theme;
    if (theme === "auto") {
      if (save) {
        localStorage.removeItem("rankflow_theme");
      }
      const isSystemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      effectiveTheme = isSystemDark ? "dark" : "light";
    } else if (save) {
      localStorage.setItem("rankflow_theme", theme);
    }

    state.theme = theme;
    // Без переходов на время смены темы — иначе часть элементов перекрашивается с задержкой
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", effectiveTheme);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    if (els.themeSelect) els.themeSelect.value = theme;
  }

  function toggleTheme() {
    const currentEffective = document.documentElement.getAttribute("data-theme") || "light";
    const nextTheme = currentEffective === "light" ? "dark" : "light";
    applyTheme(nextTheme, true);
  }

  // --- Статусы подключения Image Chest API ---
  function updateApiStatusBadge(isConnected, label) {
    if (els.apiStatusDot) {
      els.apiStatusDot.className = "status-dot " + (isConnected ? "active" : "warning");
    }
    if (els.apiStatusText) {
      els.apiStatusText.textContent = label;
    }
  }

  function updateSettingsStatusPill(status, message) {
    if (!els.imgchestStatusDot || !els.imgchestStatusText) return;

    if (status === true) {
      els.imgchestStatusDot.className = "status-dot active";
    } else if (status === "pending") {
      els.imgchestStatusDot.className = "status-dot warning";
    } else {
      els.imgchestStatusDot.className = "status-dot";
    }
    els.imgchestStatusText.textContent = message;
  }

  function checkImageChestConnection(token) {
    if (!token || !token.trim()) {
      state.username = "";
      localStorage.removeItem("rankflow_imgchest_username");
      updateApiStatusBadge(false, "Image Chest: нет токена");
      updateSettingsStatusPill(false, "Токен не указан — загрузка недоступна");
      return false;
    }

    // Токен считать настроенным, если он непустой (не блокируем приложение через /users/me)
    updateApiStatusBadge(true, "Image Chest подключён");
    updateSettingsStatusPill(true, "Токен сохранён — проверится при первой загрузке");
    return true;
  }

  async function saveToken(tokenVal) {
    const clean = (tokenVal || "").trim();
    if (!clean) {
      showToast("Введите Personal Access Token", "amber");
      return;
    }

    state.token = clean;
    localStorage.setItem("rankflow_imgchest_token", clean);
    checkImageChestConnection(clean);
    showToast("Токен сохранён", "success");
  }

  function clearToken() {
    state.token = "";
    state.username = "";
    localStorage.removeItem("rankflow_imgchest_token");
    localStorage.removeItem("rankflow_imgchest_username");
    if (els.imageChestTokenInput) els.imageChestTokenInput.value = "";
    updateApiStatusBadge(false, "Image Chest: нет токена");
    updateSettingsStatusPill(false, "Токен удалён");
    showToast("Токен удалён", "amber");
  }

  // --- Индикатор активного критерия/документа для вставки Ctrl + V ---
  function updatePasteIndicator(sectionName) {
    if (!els.pasteIndicatorPill) return;

    if (sectionName !== "promotion" && sectionName !== "sanctions") {
      els.pasteIndicatorPill.style.display = "none";
      return;
    }

    const sectionState = state[sectionName];
    if (!sectionState.divisionId || !sectionState.rank) {
      els.pasteIndicatorPill.style.display = "none";
      return;
    }

    // Если активна цель — документ (паспорт или трудовая книжка)
    if (sectionName === "promotion" && state.documents && state.documents.activeDoc) {
      const docType = state.documents.activeDoc;
      const docTitle = docType === "passport" ? "Ксерокопия паспорта" : "Ксерокопия трудовой книжки";

      els.pasteIndicatorPill.style.display = "flex";
      if (els.pasteTargetTitle) {
        els.pasteTargetTitle.textContent = docTitle;
      }

      // Снимаем подсветку с критериев
      if (els.promoCriteriaList) {
        Array.from(els.promoCriteriaList.children).forEach((c) => {
          c.classList.remove("is-paste-active");
          const badge = c.querySelector(".active-badge-indicator");
          if (badge) badge.style.display = "none";
        });
      }

      // Подсвечиваем активный документ
      if (els.cardDocPassport) els.cardDocPassport.classList.toggle("is-paste-active", docType === "passport");
      if (els.cardDocEmployment) els.cardDocEmployment.classList.toggle("is-paste-active", docType === "employment");
      if (els.docPassportActiveTag) els.docPassportActiveTag.style.display = docType === "passport" ? "inline" : "none";
      if (els.docEmploymentActiveTag) els.docEmploymentActiveTag.style.display = docType === "employment" ? "inline" : "none";
      return;
    }

    // Снимаем подсветку с документов
    if (els.cardDocPassport) els.cardDocPassport.classList.remove("is-paste-active");
    if (els.cardDocEmployment) els.cardDocEmployment.classList.remove("is-paste-active");
    if (els.docPassportActiveTag) els.docPassportActiveTag.style.display = "none";
    if (els.docEmploymentActiveTag) els.docEmploymentActiveTag.style.display = "none";

    const divData =
      sectionName === "promotion"
        ? window.CRITERIA_DATA?.promotions[sectionState.divisionId]
        : window.CRITERIA_DATA?.sanctions[sectionState.divisionId];
    const rankData = divData ? divData.ranks[sectionState.rank] : null;
    const criteriaList = rankData?.criteria || [];

    if (criteriaList.length === 0) {
      els.pasteIndicatorPill.style.display = "none";
      return;
    }

    const activeIdx = Math.min(sectionState.activeCriterionIdx || 0, criteriaList.length - 1);
    const critText = criteriaList[activeIdx] || "";
    const cleanFirstLine = critText.split("\n")[0].trim();
    const shortSnippet = cleanFirstLine.length > 40 ? cleanFirstLine.substring(0, 40) + "…" : cleanFirstLine;

    els.pasteIndicatorPill.style.display = "flex";
    if (els.pasteTargetTitle) {
      els.pasteTargetTitle.textContent = `${pad2(activeIdx + 1)} · ${shortSnippet}`;
    }

    // Синхронизируем класс is-paste-active на карточках
    const container = sectionName === "promotion" ? els.promoCriteriaList : els.sanctionCriteriaList;
    if (container) {
      Array.from(container.children).forEach((c, idx) => {
        const isCurrent = idx === activeIdx;
        c.classList.toggle("is-paste-active", isCurrent);
        const badge = c.querySelector(".active-badge-indicator");
        if (badge) badge.style.display = isCurrent ? "inline" : "none";
      });
    }
  }

  function setActiveCriterion(sectionName, criterionIdx) {
    if (sectionName === "promotion" && state.documents) {
      state.documents.activeDoc = null;
    }
    state[sectionName].activeCriterionIdx = criterionIdx;
    updatePasteIndicator(sectionName);
  }

  function setActiveDoc(docType) {
    if (state.documents) {
      state.documents.activeDoc = docType;
    }
    updatePasteIndicator("promotion");
  }

  // --- Переключение табов ---
  function switchTab(tabName) {
    state.activeTab = tabName;

    [els.navPromotion, els.navSanctions, els.navSettings].forEach((btn) => {
      if (btn) {
        btn.classList.remove("active");
        btn.removeAttribute("aria-current");
      }
    });

    [els.viewPromotion, els.viewSanctions, els.viewSettings].forEach((view) => {
      if (view) view.classList.remove("active");
    });

    if (tabName === "promotion") {
      els.navPromotion.classList.add("active");
      els.viewPromotion.classList.add("active");
      updatePasteIndicator("promotion");
    } else if (tabName === "sanctions") {
      els.navSanctions.classList.add("active");
      els.viewSanctions.classList.add("active");
      updatePasteIndicator("sanctions");
    } else if (tabName === "settings") {
      els.navSettings.classList.add("active");
      els.viewSettings.classList.add("active");
      updatePasteIndicator("settings");
    }

    const activeNav = { promotion: els.navPromotion, sanctions: els.navSanctions, settings: els.navSettings }[tabName];
    if (activeNav) activeNav.setAttribute("aria-current", "page");
    window.scrollTo({ top: 0 });
  }

  // --- Заполнение списков подразделений (с защитой от обрезания названий) ---
  function populateDivisionSelects() {
    if (!window.CRITERIA_DATA) return;

    if (els.promoDivisionSelect) {
      els.promoDivisionSelect.innerHTML = '<option value="">Выберите подразделение</option>';
      Object.keys(window.CRITERIA_DATA.promotions).forEach((divKey) => {
        const div = window.CRITERIA_DATA.promotions[divKey];
        const opt = document.createElement("option");
        opt.value = div.id;
        // Краткое понятное имя в видимой части селекта, чтобы не обрезалось «…(контр»
        opt.textContent = `${div.code} — ${div.name}`;
        // Полная информация в подсказке title
        opt.title = `${div.code} — ${div.name} (${div.sub})`;
        els.promoDivisionSelect.appendChild(opt);
      });
    }

    if (els.sanctionDivisionSelect) {
      els.sanctionDivisionSelect.innerHTML = '<option value="">Выберите подразделение</option>';
      Object.keys(window.CRITERIA_DATA.sanctions).forEach((divKey) => {
        const div = window.CRITERIA_DATA.sanctions[divKey];
        const opt = document.createElement("option");
        opt.value = div.id;
        opt.textContent = `${div.code} — ${div.name}`;
        opt.title = `${div.code} — ${div.name}`;
        els.sanctionDivisionSelect.appendChild(opt);
      });
    }
  }

  // --- Обработка выбора подразделения в «Повышении» ---
  function onPromotionDivisionChange(divisionId) {
    state.promotion.divisionId = divisionId;
    state.promotion.rank = "";
    state.promotion.completion = {};
    clearFilesMap(state.promotion.files);
    state.promotion.posts = {};
    state.promotion.activeCriterionIdx = 0;

    if (!divisionId) {
      if (els.viewPromotion) els.viewPromotion.classList.remove("has-selection");
      if (els.promoDivisionSubHint) els.promoDivisionSubHint.textContent = "";
      els.promoRankSelect.disabled = true;
      els.promoRankSelect.innerHTML = '<option value="">Сначала подразделение</option>';
      renderPromotionView();
      updatePasteIndicator("promotion");
      return;
    }

    if (els.viewPromotion) els.viewPromotion.classList.add("has-selection");
    const divisionData = window.CRITERIA_DATA.promotions[divisionId];
    if (!divisionData) return;

    if (els.promoDivisionSubHint) {
      els.promoDivisionSubHint.textContent = `Тип службы: ${divisionData.sub || "воинская часть"}`;
      els.promoDivisionSelect.title = `${divisionData.code} — ${divisionData.name} (${divisionData.sub})`;
    }

    const ranks = Object.keys(divisionData.ranks);
    els.promoRankSelect.disabled = false;
    els.promoRankSelect.innerHTML = '<option value="">Выберите звание</option>';

    ranks.forEach((rankName) => {
      const opt = document.createElement("option");
      opt.value = rankName;
      opt.textContent = rankName;
      els.promoRankSelect.appendChild(opt);
    });

    renderPromotionView();
    updatePasteIndicator("promotion");
  }

  // --- Обработка выбора звания в «Повышении» ---
  function onPromotionRankChange(rankName) {
    state.promotion.rank = rankName;
    state.reportMeta.rank = rankName;
    if (els.reportRankInput) {
      els.reportRankInput.value = rankName;
    }
    state.promotion.completion = {};
    clearFilesMap(state.promotion.files);
    state.promotion.posts = {};
    state.promotion.activeCriterionIdx = 0;
    renderPromotionView();
    updatePasteIndicator("promotion");
  }

  // --- Рендеринг раздела «Повышение» ---
  function renderPromotionView() {
    const { divisionId, rank } = state.promotion;

    if (!divisionId || !rank) {
      els.promoRankCard.style.display = "none";
      els.promoProgressBar.style.display = "none";
      els.promoCriteriaList.innerHTML = "";
      els.promoEmptyState.style.display = "flex";
      els.promoEmptyState.querySelector(".empty-state-title").textContent = !divisionId
        ? "Выберите подразделение"
        : "Выберите своё звание";
      if (els.promoDocsSection) els.promoDocsSection.style.display = "none";
      if (els.promoReportMeta) els.promoReportMeta.style.display = "none";
      if (els.promoFinalReport) els.promoFinalReport.style.display = "none";
      updatePasteIndicator("promotion");
      return;
    }

    const divData = window.CRITERIA_DATA.promotions[divisionId];
    const rankData = divData ? divData.ranks[rank] : null;

    if (!rankData) {
      els.promoRankCard.style.display = "none";
      els.promoProgressBar.style.display = "none";
      els.promoCriteriaList.innerHTML = "";
      els.promoEmptyState.style.display = "flex";
      els.promoEmptyState.querySelector(".empty-state-title").textContent =
        "Для выбранного звания дальнейшие критерии в этом подразделении отсутствуют";
      if (els.promoDocsSection) els.promoDocsSection.style.display = "none";
      if (els.promoReportMeta) els.promoReportMeta.style.display = "none";
      if (els.promoFinalReport) els.promoFinalReport.style.display = "none";
      updatePasteIndicator("promotion");
      return;
    }

    els.promoEmptyState.style.display = "none";
    els.promoRankCard.style.display = "flex";
    els.promoProgressBar.style.display = "flex";

    els.promoCurrentRankVal.textContent = rank;
    els.promoNextRankVal.textContent = rankData.nextRank || "—";
    els.promoRankDivisionText.textContent = `${divData.code} · ${divData.name}`;

    renderCriteriaCards(
      els.promoCriteriaList,
      rankData.criteria,
      "promotion",
      state.promotion
    );

    // Отображаем приложения, реквизиты и генератор рапорта
    if (els.promoDocsSection) els.promoDocsSection.style.display = "flex";
    if (els.promoReportMeta) {
      els.promoReportMeta.style.display = "flex";
      if (els.reportRankInput) {
        if (!state.reportMeta.rank) {
          state.reportMeta.rank = rank;
        }
        els.reportRankInput.value = state.reportMeta.rank;
      }
    }
    if (els.promoFinalReport) els.promoFinalReport.style.display = "flex";

    renderDocSection("passport");
    renderDocSection("employment");

    updateProgressUI("promotion");
    updatePasteIndicator("promotion");
    updateReportGenerator();
  }

  // --- Обработка выбора подразделения в «Снятии взыскания» ---
  function onSanctionDivisionChange(divisionId) {
    state.sanctions.divisionId = divisionId;
    state.sanctions.rank = "";
    state.sanctions.completion = {};
    clearFilesMap(state.sanctions.files);
    state.sanctions.posts = {};
    state.sanctions.activeCriterionIdx = 0;

    if (!divisionId) {
      if (els.viewSanctions) els.viewSanctions.classList.remove("has-selection");
      if (els.sanctionDivisionSubHint) els.sanctionDivisionSubHint.textContent = "";
      els.sanctionRankSelect.disabled = true;
      els.sanctionRankSelect.innerHTML = '<option value="">Сначала подразделение</option>';
      renderSanctionView();
      updatePasteIndicator("sanctions");
      return;
    }

    if (els.viewSanctions) els.viewSanctions.classList.add("has-selection");
    const divisionData = window.CRITERIA_DATA.sanctions[divisionId];
    if (!divisionData) return;

    if (els.sanctionDivisionSubHint) {
      els.sanctionDivisionSubHint.textContent = "";
      els.sanctionDivisionSelect.title = `${divisionData.code} — ${divisionData.name}`;
    }

    const ranks = Object.keys(divisionData.ranks);
    els.sanctionRankSelect.disabled = false;
    els.sanctionRankSelect.innerHTML = '<option value="">Выберите звание</option>';

    ranks.forEach((rankName) => {
      const opt = document.createElement("option");
      opt.value = rankName;
      opt.textContent = rankName;
      els.sanctionRankSelect.appendChild(opt);
    });

    renderSanctionView();
    updatePasteIndicator("sanctions");
  }

  // --- Обработка выбора звания в «Снятии взыскания» ---
  function onSanctionRankChange(rankName) {
    state.sanctions.rank = rankName;
    state.sanctions.completion = {};
    clearFilesMap(state.sanctions.files);
    state.sanctions.posts = {};
    state.sanctions.activeCriterionIdx = 0;
    renderSanctionView();
    updatePasteIndicator("sanctions");
  }

  // --- Рендеринг раздела «Снятие взыскания» ---
  function renderSanctionView() {
    const { divisionId, rank } = state.sanctions;

    if (!divisionId || !rank) {
      els.sanctionRankCard.style.display = "none";
      els.sanctionProgressBar.style.display = "none";
      els.sanctionCriteriaList.innerHTML = "";
      els.sanctionEmptyState.style.display = "flex";
      els.sanctionEmptyState.querySelector(".empty-state-title").textContent = !divisionId
        ? "Выберите подразделение"
        : "Выберите звание";
      updatePasteIndicator("sanctions");
      return;
    }

    const divData = window.CRITERIA_DATA.sanctions[divisionId];
    const rankData = divData ? divData.ranks[rank] : null;

    if (!rankData) {
      els.sanctionRankCard.style.display = "none";
      els.sanctionProgressBar.style.display = "none";
      els.sanctionCriteriaList.innerHTML = "";
      els.sanctionEmptyState.style.display = "flex";
      els.sanctionEmptyState.querySelector(".empty-state-title").textContent =
        "Для выбранного звания критерии отсутствуют";
      updatePasteIndicator("sanctions");
      return;
    }

    els.sanctionEmptyState.style.display = "none";
    els.sanctionRankCard.style.display = "flex";
    els.sanctionProgressBar.style.display = "flex";

    els.sanctionCurrentRankVal.textContent = rank;
    els.sanctionRankDivisionText.textContent = `${divData.code} · ${divData.name}`;

    renderCriteriaCards(
      els.sanctionCriteriaList,
      rankData.criteria,
      "sanctions",
      state.sanctions
    );

    updateProgressUI("sanctions");
    updatePasteIndicator("sanctions");
  }

  // --- Генерация HTML-карточек критериев ---
  function renderCriteriaCards(container, criteriaArray, sectionName, sectionState) {
    container.innerHTML = "";

    criteriaArray.forEach((criterionText, idx) => {
      const isDone = Boolean(sectionState.completion[idx]);
      const fileList = sectionState.files[idx] || [];
      const pendingFilesCount = fileList.filter((f) => f.status === "pending" || f.status === "error").length;
      const isActive = (sectionState.activeCriterionIdx || 0) === idx;

      const card = document.createElement("div");
      card.className = `criterion-card ${isDone ? "is-completed" : ""} ${isActive ? "is-paste-active" : ""}`;
      card.dataset.index = idx;
      card.dataset.criterionIdx = idx;
      card.dataset.section = sectionName;

      card.addEventListener("click", () => {
        setActiveCriterion(sectionName, idx);
      });

      const formattedIndex = String(idx + 1).padStart(2, "0");

      card.innerHTML = `
        <div class="crit-head">
          <label class="completion-toggle" title="Отметить как выполненный">
            <input type="checkbox" ${isDone ? "checked" : ""} data-criterion-idx="${idx}" aria-label="Критерий ${formattedIndex} выполнен">
            <span class="checkbox-custom">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
            <span class="completion-toggle-label sr-only">Выполнено</span>
          </label>
          <div class="crit-body">
            <div class="crit-meta">
              <span class="criterion-badge">${formattedIndex}</span>
              <span class="evidence-count-badge" id="count-badge-${sectionName}-${idx}">${fileList.length > 0 ? `${fileList.length} фото` : ""}</span>
              <span class="active-badge-indicator" style="display:${isActive ? "inline" : "none"};">Ctrl+V сюда</span>
            </div>
            <div class="criterion-text-body">${escapeHtml(criterionText)}</div>
          </div>
        </div>

        <div class="evidence-section">
          <div class="evidence-strip">
            <div class="preview-grid" id="preview-grid-${sectionName}-${idx}" style="${fileList.length === 0 ? "display:none;" : ""}"></div>
            <div class="dropzone-area" id="dropzone-${sectionName}-${idx}" tabindex="0" role="button" aria-label="Добавить скриншоты к критерию ${formattedIndex}">
              <input type="file" multiple accept="image/*" hidden id="file-input-${sectionName}-${idx}">
              <svg class="dz-plus" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              <span class="dropzone-prompt">Добавить скриншоты</span>
              <span class="dropzone-sub">перетащите, нажмите или Ctrl+V · до 20</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm btn-upload-criterion" id="btn-upload-single-${sectionName}-${idx}" style="display:${pendingFilesCount > 0 ? "inline-flex" : "none"};">
              ${UPLOAD_ICON} Загрузить ${pendingFilesCount} фото
            </button>
          </div>

          <div class="results-box" id="results-box-${sectionName}-${idx}" style="display:none;"></div>
        </div>
      `;

      container.appendChild(card);

      // Чекбокс
      const checkbox = card.querySelector(`input[data-criterion-idx="${idx}"]`);
      checkbox.addEventListener("change", (e) => {
        sectionState.completion[idx] = e.target.checked;
        const label = card.querySelector(".completion-toggle-label");
        if (e.target.checked) {
          card.classList.add("is-completed");
          label.textContent = "✓ Выполнено";
        } else {
          card.classList.remove("is-completed");
          label.textContent = "Выполнено";
        }
        updateProgressUI(sectionName);
      });

      // Dropzone & File Input
      const dropzone = card.querySelector(`#dropzone-${sectionName}-${idx}`);
      const fileInput = card.querySelector(`#file-input-${sectionName}-${idx}`);

      dropzone.addEventListener("click", () => {
        setActiveCriterion(sectionName, idx);
        fileInput.click();
      });
      bindKeyboardClick(dropzone);

      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          addFilesToCriterion(sectionName, idx, Array.from(e.target.files));
          fileInput.value = "";
        }
      });

      // Перетаскивать можно на всю строку критерия
      bindDropTarget(
        card,
        () => setActiveCriterion(sectionName, idx),
        (files) => addFilesToCriterion(sectionName, idx, files)
      );

      // Кнопка загрузки конкретно этого критерия
      const uploadSingleBtn = card.querySelector(`#btn-upload-single-${sectionName}-${idx}`);
      if (uploadSingleBtn) {
        uploadSingleBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          requestCriterionUpload(sectionName, idx);
        });
      }

      renderCriterionPreviews(sectionName, idx);
      renderCriterionResults(sectionName, idx);
    });
  }

  // --- Добавление файлов к критерию (с проверкой лимита 20 фото) ---
  function addFilesToCriterion(sectionName, criterionIdx, newFiles) {
    const sectionState = state[sectionName];
    if (!sectionState.files[criterionIdx]) {
      sectionState.files[criterionIdx] = [];
    }

    const currentFiles = sectionState.files[criterionIdx];

    // Проверка лимита: Image Chest позволяет до 20 фото в один пост
    if (currentFiles.length + newFiles.length > 20) {
      showToast(
        `Для одного доказательства можно загрузить максимум 20 изображений в один Image Chest post (выбрано всего: ${currentFiles.length + newFiles.length}).`,
        "error"
      );
    }

    newFiles.forEach((file) => {
      const item = {
        id: "file_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8),
        file: file,
        name: file.name || "screenshot_" + (currentFiles.length + 1) + ".png",
        size: file.size,
        objectUrl: URL.createObjectURL(file),
        status: "pending", // 'pending' | 'uploading' | 'success' | 'error'
        result: null,
        errorMsg: null,
      };

      currentFiles.push(item);
    });

    renderCriterionPreviews(sectionName, criterionIdx);
    updateProgressUI(sectionName);
    showToast(`+${newFiles.length} фото → критерий ${pad2(criterionIdx + 1)}`, "success");
  }

  // --- Рендеринг превью изображений ---
  function renderCriterionPreviews(sectionName, criterionIdx) {
    const sectionState = state[sectionName];
    const fileList = sectionState.files[criterionIdx] || [];
    const grid = document.getElementById(`preview-grid-${sectionName}-${criterionIdx}`);
    const badge = document.getElementById(`count-badge-${sectionName}-${criterionIdx}`);
    const uploadSingleBtn = document.getElementById(`btn-upload-single-${sectionName}-${criterionIdx}`);

    if (badge) {
      badge.textContent = fileList.length > 0 ? `${fileList.length} фото` : "";
    }

    const pendingCount = fileList.filter((f) => f.status === "pending" || f.status === "error").length;
    if (uploadSingleBtn) {
      uploadSingleBtn.style.display = pendingCount > 0 ? "inline-flex" : "none";
      uploadSingleBtn.innerHTML = `${UPLOAD_ICON} Загрузить ${pendingCount} фото`;
    }

    if (!grid) return;

    const card = grid.closest(".criterion-card");
    if (card) card.classList.toggle("has-files", fileList.length > 0);

    if (fileList.length === 0) {
      grid.style.display = "none";
      grid.innerHTML = "";
      return;
    }

    grid.style.display = "";
    grid.innerHTML = "";

    fileList.forEach((item, fileIdx) => {
      const el = document.createElement("div");
      el.className = "preview-item";
      el.innerHTML = previewItemHtml(item);

      const removeBtn = el.querySelector(".preview-remove-btn");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFileFromCriterion(sectionName, criterionIdx, fileIdx);
      });

      grid.appendChild(el);
    });
  }

  // --- Удаление конкретного файла ---
  function removeFileFromCriterion(sectionName, criterionIdx, fileIdx) {
    const sectionState = state[sectionName];
    const fileList = sectionState.files[criterionIdx];
    if (!fileList || !fileList[fileIdx]) return;

    if (fileList[fileIdx].objectUrl) {
      URL.revokeObjectURL(fileList[fileIdx].objectUrl);
    }

    fileList.splice(fileIdx, 1);
    renderCriterionPreviews(sectionName, criterionIdx);
    renderCriterionResults(sectionName, criterionIdx);
    updateProgressUI(sectionName);
  }

  // --- Рендеринг результата: ЕДИНЫЙ IMAGE CHEST POST НА КРИТЕРИЙ ---
  function renderCriterionResults(sectionName, criterionIdx) {
    const sectionState = state[sectionName];
    const fileList = sectionState.files[criterionIdx] || [];
    const resultsBox = document.getElementById(`results-box-${sectionName}-${criterionIdx}`);

    if (!resultsBox) return;

    const existingPost = sectionState.posts ? sectionState.posts[criterionIdx] : null;

    if (!existingPost) {
      resultsBox.style.display = "none";
      resultsBox.innerHTML = "";
      return;
    }

    if ((existingPost.uploaded && existingPost.postUrl) || existingPost.error) {
      resultsBox.style.display = "flex";
      resultsBox.innerHTML = postResultHtml(existingPost, fileList.length, {
        copy: `btn-copy-post-${sectionName}-${criterionIdx}`,
        retry: `btn-retry-upload-${sectionName}-${criterionIdx}`,
      });
      bindPostResultButtons(resultsBox, existingPost, () => requestCriterionUpload(sectionName, criterionIdx));
      return;
    }

    resultsBox.style.display = "none";
    resultsBox.innerHTML = "";
  }

  function bindPostResultButtons(resultsBox, post, onRetry) {
    const copyBtn = resultsBox.querySelector('[id^="btn-copy-"]');
    if (copyBtn && post.postUrl) {
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyToClipboard(post.postUrl, copyBtn, "Ссылка скопирована");
      });
    }
    resultsBox.querySelectorAll(".btn-copy-cdn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyToClipboard(btn.dataset.url, btn, "Ссылка скопирована");
      });
    });
    const retryBtn = resultsBox.querySelector('[id^="btn-retry-"]');
    if (retryBtn) {
      retryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRetry();
      });
    }
  }

  function getRussianImageWord(count) {
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 19) return "изображений";
    if (last === 1) return "изображение";
    if (last >= 2 && last <= 4) return "изображения";
    return "изображений";
  }

  // --- Вставка из буфера (Ctrl + V) ---
  function handleGlobalPaste(e) {
    if (state.activeTab !== "promotion" && state.activeTab !== "sanctions") return;

    // Не перехватываем вставку в текстовые поля ввода
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") && activeEl.type !== "file") {
      return;
    }

    const items = (e.clipboardData || e.originalEvent.clipboardData)?.items;
    if (!items) return;

    const imageFiles = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        const blob = items[i].getAsFile();
        if (blob) imageFiles.push(blob);
      }
    }

    if (imageFiles.length === 0) return;

    const sectionName = state.activeTab;
    const sectionState = state[sectionName];

    if (!sectionState.divisionId || !sectionState.rank) {
      showToast("Сначала выберите подразделение и звание для прикрепления доказательств", "amber");
      return;
    }

    // Если активен документ (паспорт или трудовая книжка)
    if (sectionName === "promotion" && state.documents && state.documents.activeDoc) {
      const docType = state.documents.activeDoc;
      addDocFiles(docType, imageFiles);

      if (els.pasteIndicatorPill && els.pasteTargetTitle) {
        const docName = docType === "passport" ? "паспорт" : "трудовую книжку";
        els.pasteTargetTitle.textContent = `+${imageFiles.length} фото в ${docName}`;
        flashPastePill(sectionName);
      }
      return;
    }

    const targetIdx = sectionState.activeCriterionIdx || 0;
    addFilesToCriterion(sectionName, targetIdx, imageFiles);

    if (els.pasteIndicatorPill && els.pasteTargetTitle) {
      els.pasteTargetTitle.textContent = `+${imageFiles.length} фото в критерий ${pad2(targetIdx + 1)}`;
      flashPastePill(sectionName);
    }
  }

  let pasteFlashTimer = null;
  function flashPastePill(sectionName) {
    els.pasteIndicatorPill.classList.add("is-flash");
    clearTimeout(pasteFlashTimer);
    pasteFlashTimer = setTimeout(() => {
      els.pasteIndicatorPill.classList.remove("is-flash");
      updatePasteIndicator(sectionName);
    }, 1600);
  }

  // --- Обновление общего прогресса ---
  function updateProgressUI(sectionName) {
    const sectionState = state[sectionName];
    const totalCriteria =
      sectionName === "promotion"
        ? (window.CRITERIA_DATA?.promotions[sectionState.divisionId]?.ranks[sectionState.rank]?.criteria?.length || 0)
        : (window.CRITERIA_DATA?.sanctions[sectionState.divisionId]?.ranks[sectionState.rank]?.criteria?.length || 0);

    let completedCriteria = 0;
    for (let i = 0; i < totalCriteria; i++) {
      if (sectionState.completion[i]) completedCriteria++;
    }

    const percent = totalCriteria > 0 ? Math.round((completedCriteria / totalCriteria) * 100) : 0;

    const fillEl = sectionName === "promotion" ? els.promoProgressFill : els.sanctionProgressFill;
    const countEl = sectionName === "promotion" ? els.promoProgressCount : els.sanctionProgressCount;
    const uploadBtn = sectionName === "promotion" ? els.promoUploadAllBtn : els.sanctionUploadAllBtn;

    if (fillEl) fillEl.style.width = `${percent}%`;
    if (countEl) countEl.textContent = `${completedCriteria} / ${totalCriteria}`;

    // Считаем все файлы, ожидающие загрузки
    let totalPendingFiles = 0;
    Object.values(sectionState.files).forEach((filesArr) => {
      filesArr.forEach((f) => {
        if (f.status === "pending" || f.status === "error") totalPendingFiles++;
      });
    });

    if (uploadBtn) {
      uploadBtn.disabled = totalPendingFiles === 0 || state.upload.isUploading;
      uploadBtn.innerHTML = totalPendingFiles > 0
        ? `${UPLOAD_ICON} Загрузить всё · ${totalPendingFiles} фото`
        : `${UPLOAD_ICON} Нечего загружать`;
    }

    if (sectionName === "promotion") {
      updateReportGenerator();
    }
  }

  // --- Сброс отметок выполнения ---
  function resetCriteriaCompletion(sectionName) {
    const sectionState = state[sectionName];
    sectionState.completion = {};

    const container = sectionName === "promotion" ? els.promoCriteriaList : els.sanctionCriteriaList;
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      cb.checked = false;
      const card = cb.closest(".criterion-card");
      if (card) {
        card.classList.remove("is-completed");
        const label = card.querySelector(".completion-toggle-label");
        if (label) label.textContent = "Выполнено";
      }
    });

    updateProgressUI(sectionName);
    showToast("Отметки сняты", "amber");
  }

  // --- Запрос загрузки отдельного критерия ---
  function requestCriterionUpload(sectionName, criterionIdx) {
    if (!state.token) {
      showToast("Перед загрузкой укажите Image Chest Personal Access Token в Настройках", "error");
      switchTab("settings");
      return;
    }

    const sectionState = state[sectionName];
    const fileList = sectionState.files[criterionIdx] || [];
    const pendingFiles = fileList.filter((f) => f.status === "pending" || f.status === "error");

    if (pendingFiles.length === 0) {
      showToast("Нет файлов, ожидающих загрузки для этого критерия", "amber");
      return;
    }

    if (pendingFiles.length > 20) {
      showToast("Для одного доказательства можно загрузить максимум 20 изображений в один Image Chest post.", "error");
      return;
    }

    const summaryHtml = `<div class="sum-row"><span>Критерий ${pad2(criterionIdx + 1)}</span><b>${pendingFiles.length} фото</b></div>`;

    els.confirmModalSummary.innerHTML = summaryHtml;
    els.confirmModal.dataset.section = sectionName;
    els.confirmModal.dataset.criterionIdx = String(criterionIdx);
    els.confirmModal.classList.add("active");
  }

  // --- Запуск подтверждения массовой загрузки ---
  function requestBatchUpload(sectionName) {
    if (!state.token) {
      showToast("Перед загрузкой необходимо указать Image Chest Token в Настройках", "error");
      switchTab("settings");
      return;
    }

    const sectionState = state[sectionName];
    const pendingCriteria = [];
    let hasOverLimit = false;

    Object.keys(sectionState.files).forEach((critIdx) => {
      const arr = sectionState.files[critIdx];
      const pendingForCrit = arr.filter((f) => f.status === "pending" || f.status === "error");
      if (pendingForCrit.length > 0) {
        if (pendingForCrit.length > 20) {
          hasOverLimit = true;
        }
        pendingCriteria.push({
          criterionIdx: Number(critIdx),
          files: pendingForCrit,
        });
      }
    });

    if (hasOverLimit) {
      showToast("Для одного доказательства можно загрузить максимум 20 изображений в один Image Chest post. Пожалуйста, уменьшите количество файлов.", "error");
      return;
    }

    const totalFiles = pendingCriteria.reduce((sum, item) => sum + item.files.length, 0);

    if (totalFiles === 0) {
      showToast("Все доказательства уже загружены или ещё не добавлены", "amber");
      return;
    }

    let summaryHtml = "";
    pendingCriteria.forEach((item) => {
      summaryHtml += `<div class="sum-row"><span>Критерий ${pad2(item.criterionIdx + 1)}</span><b>${item.files.length} фото</b></div>`;
    });
    summaryHtml += `<div class="sum-row sum-total"><span>Всего</span><b>${totalFiles} фото</b></div>`;

    els.confirmModalSummary.innerHTML = summaryHtml;
    els.confirmModal.dataset.section = sectionName;
    els.confirmModal.dataset.criterionIdx = "all";
    els.confirmModal.classList.add("active");
  }

  // --- Процесс создания/добавления в Image Chest Post ---
  async function executeBatchUpload(sectionName, targetCriterionIdx = "all") {
    els.confirmModal.classList.remove("active");

    const sectionState = state[sectionName];
    const criteriaToProcess = [];

    const criteriaKeys =
      targetCriterionIdx !== "all"
        ? [Number(targetCriterionIdx)]
        : Object.keys(sectionState.files).map(Number);

    criteriaKeys.forEach((cIdx) => {
      const arr = sectionState.files[cIdx] || [];
      const pendingItems = arr.filter((f) => f.status === "pending" || f.status === "error");
      if (pendingItems.length > 0) {
        criteriaToProcess.push({
          criterionIdx: cIdx,
          items: pendingItems,
        });
      }
    });

    if (criteriaToProcess.length === 0) return;

    state.upload.isUploading = true;
    state.upload.totalCount = criteriaToProcess.length;
    state.upload.currentCount = 0;
    state.upload.hasErrors = false;

    // Блокируем кнопки
    updateProgressUI(sectionName);

    els.progressModalTitle.textContent = `Загрузка в Image Chest... (0 / ${criteriaToProcess.length})`;
    els.progressModalSub.textContent = `Подготовка постов...`;
    els.progressModalFill.style.width = "0%";
    els.progressModal.classList.add("active");

    const divData =
      sectionName === "promotion"
        ? window.CRITERIA_DATA?.promotions[sectionState.divisionId]
        : window.CRITERIA_DATA?.sanctions[sectionState.divisionId];
    const divCode = divData ? divData.code : "ВЧ";

    for (let i = 0; i < criteriaToProcess.length; i++) {
      if (!state.upload.isUploading) break; // Отмена пользователем

      const { criterionIdx, items } = criteriaToProcess[i];
      const rawFiles = items.map((it) => it.file);

      // Ставим статус uploading
      items.forEach((it) => (it.status = "uploading"));
      renderCriterionPreviews(sectionName, criterionIdx);

      els.progressModalTitle.textContent = `Загрузка в Image Chest... (${i + 1} / ${criteriaToProcess.length})`;
      els.progressModalSub.textContent = `Критерий ${pad2(criterionIdx + 1)}: загрузка ${items.length} фото одним постом...`;
      els.progressModalFill.style.width = `${Math.round(((i + 1) / criteriaToProcess.length) * 100)}%`;

      if (!sectionState.posts) sectionState.posts = {};
      const existingPost = sectionState.posts[criterionIdx];

      try {
        let postRes;

        // Если пост для этого критерия уже существует — добавляем новые фотографии через /post/{id}/add
        if (existingPost && existingPost.postId) {
          postRes = await window.ImageChestService.addImagesToPost({
            token: state.token,
            postId: existingPost.postId,
            files: rawFiles,
          });
        } else {
          // Иначе создаем новый пост для этого критерия
          let title = "";
          if (sectionName === "promotion") {
            const rankData = divData?.ranks[sectionState.rank];
            const nextRank = rankData?.nextRank || "Очередное звание";
            title = `${divCode} — ${sectionState.rank} → ${nextRank} — Критерий ${pad2(criterionIdx + 1)}`;
          } else {
            title = `${divCode} — ${sectionState.rank} — Снятие взыскания — Критерий ${pad2(criterionIdx + 1)}`;
          }

          postRes = await window.ImageChestService.createPost({
            token: state.token,
            title: title,
            files: rawFiles,
          });
        }

        if (postRes.success) {
          items.forEach((it) => {
            it.status = "success";
            it.errorMsg = null;
          });

          // Сохраняем пост в состоянии критерия
          sectionState.posts[criterionIdx] = {
            uploaded: true,
            postId: postRes.postId,
            postUrl: postRes.postUrl,
            imageCount: postRes.imageCount,
            images: postRes.images || (existingPost?.images ? [...existingPost.images, ...(postRes.images || [])] : []),
          };
        } else {
          items.forEach((it) => {
            it.status = "error";
            it.errorMsg = postRes.error;
          });
          if (!existingPost || !existingPost.uploaded) {
            sectionState.posts[criterionIdx] = {
              uploaded: false,
              error: postRes.error,
            };
          }
          state.upload.hasErrors = true;
          showToast(`Критерий ${pad2(criterionIdx + 1)}: ${postRes.error}`, "error");
        }
      } catch (err) {
        items.forEach((it) => {
          it.status = "error";
          it.errorMsg = err.message || "Ошибка соединения с Image Chest";
        });
        if (!existingPost || !existingPost.uploaded) {
          sectionState.posts[criterionIdx] = {
            uploaded: false,
            error: err.message || "Ошибка соединения с Image Chest",
          };
        }
        state.upload.hasErrors = true;
        showToast(`Ошибка Image Chest при загрузке критерия ${pad2(criterionIdx + 1)}`, "error");
      }

      renderCriterionPreviews(sectionName, criterionIdx);
      renderCriterionResults(sectionName, criterionIdx);
      if (sectionName === "promotion") {
        updateReportGenerator();
      }
    }

    state.upload.isUploading = false;
    els.progressModal.classList.remove("active");
    updateProgressUI(sectionName);
    if (sectionName === "promotion") {
      updateReportGenerator();
    }

    if (state.upload.hasErrors) {
      showToast("Часть загрузок не прошла — нажмите «Повторить» у этих пунктов", "error");
    } else {
      showToast("Всё загружено в Image Chest", "success");
    }
  }

  // ==========================================================================
  // РАЗДЕЛ: ОБЯЗАТЕЛЬНЫЕ ПРИЛОЖЕНИЯ (ПАСПОРТ И ТРУДОВАЯ КНИЖКА)
  // 1 документ = 1 Image Chest Post = 1 ссылка. Приватность: hidden.
  // ==========================================================================

  function addDocFiles(docType, rawFiles) {
    const docState = state.documents[docType];
    const validImages = rawFiles.filter((f) => f.type.startsWith("image/"));

    if (validImages.length === 0) {
      showToast("Выберите файлы изображений (PNG, JPG, WEBP)", "amber");
      return;
    }

    // Лимит до 20 изображений на один пост Image Chest
    const currentCount = docState.files.length;
    if (currentCount + validImages.length > 20) {
      showToast("Для одного документа можно прикрепить максимум 20 изображений (один post)", "error");
      return;
    }

    validImages.forEach((f) => {
      docState.files.push({
        id: Math.random().toString(36).substring(2, 9),
        file: f,
        name: f.name,
        size: f.size,
        objectUrl: URL.createObjectURL(f),
        status: "pending",
        errorMsg: null,
      });
    });

    setActiveDoc(docType);
    renderDocSection(docType);
    updateReportGenerator();
    showToast(`✓ Добавлено ${validImages.length} фото в ${docType === "passport" ? "паспорт" : "трудовую книжку"}`, "info");
  }

  function removeDocFile(docType, fileIdx) {
    const docState = state.documents[docType];
    const fileList = docState.files;
    if (!fileList || !fileList[fileIdx]) return;

    if (fileList[fileIdx].objectUrl) {
      URL.revokeObjectURL(fileList[fileIdx].objectUrl);
    }

    fileList.splice(fileIdx, 1);
    if (fileList.length === 0) {
      docState.post = null;
    }

    renderDocSection(docType);
    updateReportGenerator();
  }

  function renderDocSection(docType) {
    const isPass = docType === "passport";
    const countBadge = isPass ? els.countBadgeDocPassport : els.countBadgeDocEmployment;
    const btnUpload = isPass ? els.btnUploadDocPassport : els.btnUploadDocEmployment;

    const docState = state.documents[docType];
    const fileList = docState.files || [];
    const pendingCount = fileList.filter((f) => f.status === "pending" || f.status === "error").length;

    if (countBadge) {
      const uploaded = Boolean(docState.post && docState.post.uploaded);
      countBadge.classList.toggle("is-uploaded", uploaded);
      if (uploaded) {
        countBadge.textContent = "✓ загружено";
      } else if (fileList.length === 0) {
        countBadge.textContent = "";
      } else {
        countBadge.textContent = `${fileList.length} фото`;
      }
    }

    if (btnUpload) {
      if (pendingCount > 0 && (!docState.post || !docState.post.uploaded)) {
        btnUpload.style.display = "inline-flex";
        btnUpload.innerHTML = `${UPLOAD_ICON} Загрузить ${pendingCount} фото`;
      } else {
        btnUpload.style.display = "none";
      }
    }

    renderDocPreviews(docType);
    renderDocResults(docType);
  }

  function renderDocPreviews(docType) {
    const isPass = docType === "passport";
    const grid = isPass ? els.previewGridDocPassport : els.previewGridDocEmployment;
    if (!grid) return;

    const fileList = state.documents[docType].files || [];
    const card = isPass ? els.cardDocPassport : els.cardDocEmployment;
    if (card) card.classList.toggle("has-files", fileList.length > 0);
    if (fileList.length === 0) {
      grid.style.display = "none";
      grid.innerHTML = "";
      return;
    }

    grid.style.display = "";
    grid.innerHTML = "";

    fileList.forEach((item, fileIdx) => {
      const el = document.createElement("div");
      el.className = "preview-item";
      el.innerHTML = previewItemHtml(item);

      const removeBtn = el.querySelector(".preview-remove-btn");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeDocFile(docType, fileIdx);
      });

      grid.appendChild(el);
    });
  }

  function renderDocResults(docType) {
    const isPass = docType === "passport";
    const resultsBox = isPass ? els.resultsBoxDocPassport : els.resultsBoxDocEmployment;
    if (!resultsBox) return;

    const docState = state.documents[docType];
    const existingPost = docState.post;

    if (!existingPost) {
      resultsBox.style.display = "none";
      resultsBox.innerHTML = "";
      return;
    }

    resultsBox.style.display = "flex";
    resultsBox.innerHTML = postResultHtml(existingPost, docState.files ? docState.files.length : 1, {
      copy: `btn-copy-doc-post-${docType}`,
      retry: `btn-retry-doc-${docType}`,
    });
    bindPostResultButtons(resultsBox, existingPost, () => requestDocUpload(docType));
  }

  function requestDocUpload(docType) {
    if (!state.token) {
      showToast("Для загрузки укажите API токен в разделе Настройки", "error");
      switchTab("settings");
      if (els.imageChestTokenInput) els.imageChestTokenInput.focus();
      return;
    }

    const docState = state.documents[docType];
    const pendingFiles = (docState.files || []).filter(
      (f) => f.status === "pending" || f.status === "error"
    );

    if (pendingFiles.length === 0) {
      showToast("Нет новых файлов для загрузки", "amber");
      return;
    }

    state.pendingDocUpload = docType;
    const docTitle = docType === "passport" ? "Ксерокопия паспорта" : "Ксерокопия трудовой книжки";

    if (els.docSecurityModalInfo) {
      els.docSecurityModalInfo.textContent = `${docTitle}: ${pendingFiles.length} ${getRussianImageWord(pendingFiles.length)}. Уровень приватности: hidden. 1 документ = 1 Image Chest Post = 1 ссылка.`;
    }

    if (els.docSecurityModal) {
      els.docSecurityModal.classList.add("active");
    }
  }

  async function executeDocUpload(docType) {
    const docState = state.documents[docType];
    const pendingItems = (docState.files || []).filter(
      (f) => f.status === "pending" || f.status === "error"
    );

    if (pendingItems.length === 0) return;

    pendingItems.forEach((it) => (it.status = "uploading"));
    renderDocPreviews(docType);
    renderDocSection(docType);

    const rawFiles = pendingItems.map((it) => it.file);
    const docTitle = docType === "passport" ? "Ксерокопия паспорта" : "Ксерокопия трудовой книжки";

    showToast(`Загрузка ${docTitle.toLowerCase()} в Image Chest...`, "info");

    try {
      let postRes;
      if (docState.post && docState.post.postId) {
        postRes = await window.ImageChestService.addImagesToPost({
          token: state.token,
          postId: docState.post.postId,
          files: rawFiles,
        });
      } else {
        postRes = await window.ImageChestService.createPost({
          token: state.token,
          title: `ВЧ №9170174 — ${docTitle}`,
          files: rawFiles,
          privacy: "hidden",
        });
      }

      if (postRes.success) {
        pendingItems.forEach((it) => {
          it.status = "success";
          it.errorMsg = null;
        });

        docState.post = {
          uploaded: true,
          postId: postRes.postId,
          postUrl: postRes.postUrl,
          imageCount: postRes.imageCount,
          images: postRes.images || (docState.post?.images ? [...docState.post.images, ...(postRes.images || [])] : []),
        };

        showToast(`✓ ${docTitle} успешно загружена в Image Chest!`, "success");
      } else {
        pendingItems.forEach((it) => {
          it.status = "error";
          it.errorMsg = postRes.error;
        });

        if (!docState.post || !docState.post.uploaded) {
          docState.post = {
            uploaded: false,
            error: postRes.error,
          };
        }

        showToast(`Ошибка Image Chest: ${postRes.error}`, "error");
      }
    } catch (err) {
      pendingItems.forEach((it) => {
        it.status = "error";
        it.errorMsg = err.message || "Ошибка соединения";
      });

      if (!docState.post || !docState.post.uploaded) {
        docState.post = {
          uploaded: false,
          error: err.message || "Ошибка соединения",
        };
      }

      showToast(`Ошибка соединения при загрузке ${docTitle.toLowerCase()}`, "error");
    }

    renderDocPreviews(docType);
    renderDocResults(docType);
    renderDocSection(docType);
    updateReportGenerator();
  }

  // ==========================================================================
  // РАЗДЕЛ: ГОТОВЫЙ РАПОРТ В BBCODE / ЖЁСТКИЙ НЕИЗМЕНЯЕМЫЙ ШАБЛОН
  // ==========================================================================

  function generateBBCode() {
    const { divisionId, rank } = state.promotion;
    const divData = window.CRITERIA_DATA?.promotions[divisionId];
    const rankData = divData?.ranks[rank];

    const position = (state.reportMeta.position || "").trim();
    const userRank = (state.reportMeta.rank !== undefined && state.reportMeta.rank !== "" ? state.reportMeta.rank : rank || "").trim();
    const fio = (state.reportMeta.fio || "").trim();
    const date = (state.reportMeta.date || "").trim() || getTodayDateString();
    const signature = (state.reportMeta.signature || "").trim();

    // 1. Ксерокопия паспорта: ссылка или пусто
    const passportPost = state.documents.passport.post;
    const passportLink = passportPost && passportPost.uploaded && passportPost.postUrl
      ? `[url=${passportPost.postUrl}]Открыть доказательства[/url]`
      : "";

    // 2. Ксерокопия трудовой книжки: ссылка или пусто
    const empPost = state.documents.employment.post;
    const empLink = empPost && empPost.uploaded && empPost.postUrl
      ? `[url=${empPost.postUrl}]Открыть доказательства[/url]`
      : "";

    // 3. Перечень выполненных задач: добавлять ТОЛЬКО выполненные пользователем критерии
    const criteriaLines = [];
    if (rankData && rankData.criteria) {
      rankData.criteria.forEach((critText, idx) => {
        const isDone = Boolean(state.promotion.completion[idx]) || Boolean(state.promotion.posts[idx]?.uploaded);
        if (!isDone) return;

        // Каждый критерий остается дословно таким, каким он находится в criteriaData
        const rawText = critText.trim();
        const prefix = rawText.startsWith("—") ? "" : "— ";
        let line = `${prefix}${rawText}`;

        const cPost = state.promotion.posts[idx];
        if (cPost && cPost.uploaded && cPost.postUrl) {
          if (!line.endsWith(";")) {
            line += ";";
          }
          line += ` [url=${cPost.postUrl}]CD-носитель[/url]`;
        }

        criteriaLines.push(line);
      });
    }

    const criteriaBlock = criteriaLines.join("\n");

    // Исходный неизменяемый шаблон BBCode
    const rawTemplate = `[RIGHT][SIZE=15px][FONT=Arial]Командиру авианосца "Осипов"
капитану 1-го ранга [B]Адмиралову К.Д.[/B] [/FONT][/SIZE][/RIGHT]

[CENTER][FONT=Arial][B]Р А П О Р Т [/B][/FONT][/CENTER]

[SIZE=15px][FONT=Arial]Я, {ДОЛЖНОСТЬ}, {ЗВАНИЕ}, [B]{ФИО}[/B], прошу рассмотреть мой рапорт о проделанной работе на присвоение очередного воинского звания. К рапорту прикладываю копии всех необходимых документов и подтверждающие материалы выполненной работы.

Приложения:
1. Ксерокопия паспорта: {ПАСПОРТ_LINK}
2. Ксерокопия трудовой книжки: {ТРУДОВАЯ_LINK}
3. Перечень выполненных задач:
{CRITERIA}[/FONT][/SIZE]


[RIGHT][FONT=Arial]Дата: {ДАТА}[/FONT]
[SIZE=15px][FONT=Arial]Подпись: {ПОДПИСЬ}[/FONT][/SIZE][/RIGHT]
[FONT=Arial][non_personal] [/non_personal][/FONT]`;

    let result = rawTemplate;
    result = result.replace("{ДОЛЖНОСТЬ}", position);
    result = result.replace("{ЗВАНИЕ}", userRank);
    result = result.replace("{ФИО}", fio);
    result = result.replace(
      "1. Ксерокопия паспорта: {ПАСПОРТ_LINK}",
      passportLink ? `1. Ксерокопия паспорта: ${passportLink}` : "1. Ксерокопия паспорта:"
    );
    result = result.replace(
      "2. Ксерокопия трудовой книжки: {ТРУДОВАЯ_LINK}",
      empLink ? `2. Ксерокопия трудовой книжки: ${empLink}` : "2. Ксерокопия трудовой книжки:"
    );
    result = result.replace("{CRITERIA}", criteriaBlock);
    result = result.replace("{ДАТА}", date);
    result = result.replace("{ПОДПИСЬ}", signature);

    return result;
  }

  function updateReportGenerator() {
    if (!els.bbcodeOutputTextarea) return;

    const { divisionId, rank } = state.promotion;
    if (!divisionId || !rank) {
      els.bbcodeOutputTextarea.value = "";
      return;
    }

    const divData = window.CRITERIA_DATA?.promotions[divisionId];
    const rankData = divData?.ranks[rank];
    const criteriaCount = rankData?.criteria?.length || 0;

    let completedCriteriaCount = 0;
    let uploadedCriteriaPosts = 0;
    for (let i = 0; i < criteriaCount; i++) {
      if (state.promotion.completion[i]) completedCriteriaCount++;
      if (state.promotion.posts[i]?.uploaded) uploadedCriteriaPosts++;
    }

    const passportUploaded = Boolean(state.documents.passport.post?.uploaded);
    const empUploaded = Boolean(state.documents.employment.post?.uploaded);
    const hasFio = Boolean((state.reportMeta.fio || "").trim());
    const hasPos = Boolean((state.reportMeta.position || "").trim());
    const hasSig = Boolean((state.reportMeta.signature || "").trim());

    const isAllCriteriaDone = completedCriteriaCount === criteriaCount && criteriaCount > 0;
    const isAllCriteriaUploaded = uploadedCriteriaPosts === criteriaCount && criteriaCount > 0;
    const isFullyReady = isAllCriteriaDone && isAllCriteriaUploaded && passportUploaded && empUploaded && hasFio && hasPos && hasSig;

    // Бейдж готовности
    if (els.reportReadinessBadge && els.reportReadinessDot && els.reportReadinessText) {
      if (isFullyReady) {
        els.reportReadinessBadge.className = "report-readiness-pill ready";
        els.reportReadinessDot.className = "status-dot online";
        els.reportReadinessText.textContent = "Рапорт готов";
      } else {
        els.reportReadinessBadge.className = "report-readiness-pill warning";
        els.reportReadinessDot.className = "status-dot warning";
        els.reportReadinessText.textContent = "Рапорт ещё не готов";
      }
    }

    // Чеклист компонентов рапорта
    if (els.reportChecklistBox) {
      const metaFilled = [hasFio, hasPos, hasSig].filter(Boolean).length;
      const items = [
        {
          label: "Критерии отмечены",
          count: `${completedCriteriaCount}/${criteriaCount}`,
          done: isAllCriteriaDone,
          warn: !isAllCriteriaDone && completedCriteriaCount > 0,
          target: "promo-criteria-list",
        },
        {
          label: "Скриншоты загружены",
          count: `${uploadedCriteriaPosts}/${criteriaCount}`,
          done: isAllCriteriaUploaded,
          warn: !isAllCriteriaUploaded && uploadedCriteriaPosts > 0,
          target: "promo-criteria-list",
        },
        { label: "Паспорт", done: passportUploaded, target: "card-doc-passport" },
        { label: "Трудовая книжка", done: empUploaded, target: "card-doc-employment" },
        {
          label: "Реквизиты",
          count: `${metaFilled}/3`,
          done: metaFilled === 3,
          warn: metaFilled > 0 && metaFilled < 3,
          target: "promo-report-meta",
        },
      ];

      els.reportChecklistBox.innerHTML = items
        .map((it) => {
          const iconClass = it.done ? "done" : it.warn ? "warn" : "pending";
          return `
            <button type="button" class="checklist-item${it.done ? " is-done" : ""}" data-target="${it.target}">
              <span class="checklist-icon ${iconClass}">${it.done ? "✓" : ""}</span>
              <span>${it.label}</span>
              ${it.count ? `<span class="checklist-count">${it.count}</span>` : ""}
            </button>
          `;
        })
        .join("");
    }

    els.bbcodeOutputTextarea.value = generateBBCode();
  }

  function initDocumentsAndReport() {
    ["passport", "employment"].forEach((docType) => {
      const isPass = docType === "passport";
      const card = isPass ? els.cardDocPassport : els.cardDocEmployment;
      const dropzone = isPass ? els.dropzoneDocPassport : els.dropzoneDocEmployment;
      const fileInput = isPass ? els.fileInputDocPassport : els.fileInputDocEmployment;
      const btnUpload = isPass ? els.btnUploadDocPassport : els.btnUploadDocEmployment;

      if (!card || !dropzone || !fileInput) return;

      card.addEventListener("click", () => {
        setActiveDoc(docType);
      });

      dropzone.addEventListener("click", () => {
        setActiveDoc(docType);
        fileInput.click();
      });
      bindKeyboardClick(dropzone);

      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          addDocFiles(docType, Array.from(e.target.files));
          fileInput.value = "";
        }
      });

      bindDropTarget(
        card,
        () => setActiveDoc(docType),
        (files) => addDocFiles(docType, files)
      );

      if (btnUpload) {
        btnUpload.addEventListener("click", (e) => {
          e.stopPropagation();
          requestDocUpload(docType);
        });
      }
    });

    // Поля реквизитов
    if (els.reportPositionInput) {
      els.reportPositionInput.value = state.reportMeta.position;
      els.reportPositionInput.addEventListener("input", (e) => {
        state.reportMeta.position = e.target.value;
        localStorage.setItem("rankflow_report_pos", e.target.value);
        updateReportGenerator();
      });
    }

    if (els.reportRankInput) {
      els.reportRankInput.addEventListener("input", (e) => {
        state.reportMeta.rank = e.target.value;
        updateReportGenerator();
      });
    }

    if (els.reportFioInput) {
      els.reportFioInput.value = state.reportMeta.fio;
      els.reportFioInput.addEventListener("input", (e) => {
        state.reportMeta.fio = e.target.value;
        localStorage.setItem("rankflow_report_fio", e.target.value);
        updateReportGenerator();
      });
    }

    if (els.reportDateInput) {
      els.reportDateInput.value = state.reportMeta.date;
      els.reportDateInput.addEventListener("input", (e) => {
        state.reportMeta.date = e.target.value;
        updateReportGenerator();
      });
    }

    if (els.reportSignatureInput) {
      els.reportSignatureInput.value = state.reportMeta.signature;
      els.reportSignatureInput.addEventListener("input", (e) => {
        state.reportMeta.signature = e.target.value;
        localStorage.setItem("rankflow_report_signature", e.target.value);
        updateReportGenerator();
      });
    }

    // Кнопки обновления и копирования рапорта
    if (els.btnRefreshReport) {
      els.btnRefreshReport.addEventListener("click", () => {
        updateReportGenerator();
        showToast("✓ Рапорт обновлен", "info");
      });
    }

    if (els.btnCopyReport) {
      els.btnCopyReport.addEventListener("click", () => {
        if (!els.bbcodeOutputTextarea.value) return;
        copyToClipboard(
          els.bbcodeOutputTextarea.value,
          els.btnCopyReport,
          "Рапорт скопирован — вставляйте на форум"
        );
      });
    }

    if (els.btnCopyReportMini) {
      els.btnCopyReportMini.addEventListener("click", () => {
        if (!els.bbcodeOutputTextarea.value) return;
        copyToClipboard(
          els.bbcodeOutputTextarea.value,
          els.btnCopyReportMini,
          "Рапорт скопирован"
        );
      });
    }

    if (els.reportChecklistBox) {
      els.reportChecklistBox.addEventListener("click", (e) => {
        const item = e.target.closest(".checklist-item");
        const target = item && document.getElementById(item.dataset.target);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    // Модальное окно подтверждения безопасности персональных данных
    if (els.docSecurityModalClose) {
      els.docSecurityModalClose.addEventListener("click", () => {
        if (els.docSecurityModal) els.docSecurityModal.classList.remove("active");
      });
    }

    if (els.docSecurityBtnCancel) {
      els.docSecurityBtnCancel.addEventListener("click", () => {
        if (els.docSecurityModal) els.docSecurityModal.classList.remove("active");
      });
    }

    if (els.docSecurityBtnProceed) {
      els.docSecurityBtnProceed.addEventListener("click", () => {
        if (els.docSecurityModal) els.docSecurityModal.classList.remove("active");
        if (state.pendingDocUpload) {
          executeDocUpload(state.pendingDocUpload);
        }
      });
    }
  }

  // --- Очистка хранилищ файлов ---
  function clearFilesMap(filesMap) {
    if (!filesMap) return;
    Object.values(filesMap).forEach((arr) => {
      if (Array.isArray(arr)) {
        arr.forEach((item) => {
          if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
        });
      }
    });
    for (let k in filesMap) delete filesMap[k];
  }

  // --- Утилита копирования в буфер обмена ---
  function copyToClipboard(text, triggerBtn, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => handleCopySuccess(triggerBtn, successMessage))
        .catch(() => fallbackCopyText(text, triggerBtn, successMessage));
    } else {
      fallbackCopyText(text, triggerBtn, successMessage);
    }
  }

  function fallbackCopyText(text, triggerBtn, successMessage) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand("copy");
      handleCopySuccess(triggerBtn, successMessage);
    } catch (e) {
      showToast("Не удалось скопировать. Скопируйте ссылку вручную.", "error");
    }
    document.body.removeChild(textArea);
  }

  function handleCopySuccess(btn, message) {
    showToast(message || "Скопировано", "success");
    if (btn) {
      const originalText = btn.innerHTML;
      btn.innerHTML = `✓ Скопировано`;
      btn.classList.add("is-copied");
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.classList.remove("is-copied");
      }, 1800);
    }
  }

  // --- Система всплывающих уведомлений (Toasts) ---
  function showToast(message, type = "info") {
    if (!els.toastContainer) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    let iconSvg = "";
    if (type === "success") {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === "error") {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else if (type === "amber") {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.transition = "opacity 0.18s ease, transform 0.18s ease";
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-6px)";
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 200);
    }, 3200);
  }

  // --- Вспомогательные функции ---
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return "0 Б";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Б", "КБ", "МБ", "ГБ"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }

  // --- Привязка основных событий DOM ---
  function attachEventListeners() {
    // Вкладки
    els.navPromotion.addEventListener("click", () => switchTab("promotion"));
    els.navSanctions.addEventListener("click", () => switchTab("sanctions"));
    els.navSettings.addEventListener("click", () => switchTab("settings"));

    // Кнопка темы
    els.themeToggle.addEventListener("click", toggleTheme);

    // Статус API в боковой панели ведёт в «Настройки»
    if (els.apiStatusHeader) {
      els.apiStatusHeader.addEventListener("click", (e) => {
        e.preventDefault();
        switchTab("settings");
      });
    }

    // Селекторы Повышения
    els.promoDivisionSelect.addEventListener("change", (e) => {
      onPromotionDivisionChange(e.target.value);
    });

    els.promoRankSelect.addEventListener("change", (e) => {
      onPromotionRankChange(e.target.value);
    });

    // Селекторы Снятия взыскания
    els.sanctionDivisionSelect.addEventListener("change", (e) => {
      onSanctionDivisionChange(e.target.value);
    });

    els.sanctionRankSelect.addEventListener("change", (e) => {
      onSanctionRankChange(e.target.value);
    });

    // Сброс отметок выполнения
    els.promoResetBtn.addEventListener("click", () => resetCriteriaCompletion("promotion"));
    els.sanctionResetBtn.addEventListener("click", () => resetCriteriaCompletion("sanctions"));

    // Кнопки загрузки всех доказательств
    els.promoUploadAllBtn.addEventListener("click", () => requestBatchUpload("promotion"));
    els.sanctionUploadAllBtn.addEventListener("click", () => requestBatchUpload("sanctions"));

    // Настройки Image Chest API
    if (els.toggleTokenVisibilityBtn && els.imageChestTokenInput) {
      els.toggleTokenVisibilityBtn.addEventListener("click", () => {
        const isPass = els.imageChestTokenInput.type === "password";
        els.imageChestTokenInput.type = isPass ? "text" : "password";
        els.toggleTokenVisibilityBtn.textContent = isPass ? "Скрыть" : "Показать";
      });
    }

    if (els.saveTokenBtn && els.imageChestTokenInput) {
      els.saveTokenBtn.addEventListener("click", () => {
        saveToken(els.imageChestTokenInput.value);
      });

      els.imageChestTokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          saveToken(els.imageChestTokenInput.value);
        }
      });
    }

    if (els.clearTokenBtn) {
      els.clearTokenBtn.addEventListener("click", clearToken);
    }

    if (els.themeSelect) {
      els.themeSelect.addEventListener("change", (e) => {
        applyTheme(e.target.value);
      });
    }

    if (els.clearStorageBtn) {
      els.clearStorageBtn.addEventListener("click", () => {
        if (confirm("Вы уверены, что хотите сбросить все локальные настройки и токен Image Chest?")) {
          clearToken();
          clearFilesMap(state.promotion.files);
          clearFilesMap(state.sanctions.files);
          if (state.documents) {
            ["passport", "employment"].forEach((d) => {
              if (state.documents[d].files) {
                state.documents[d].files.forEach((f) => {
                  if (f.objectUrl) URL.revokeObjectURL(f.objectUrl);
                });
                state.documents[d].files = [];
              }
              state.documents[d].post = null;
            });
            state.documents.activeDoc = null;
          }
          localStorage.removeItem("rankflow_report_pos");
          localStorage.removeItem("rankflow_report_fio");
          localStorage.removeItem("rankflow_report_signature");
          state.reportMeta.position = "";
          state.reportMeta.fio = "";
          state.reportMeta.signature = "";
          state.reportMeta.date = getTodayDateString();
          if (els.reportPositionInput) els.reportPositionInput.value = "";
          if (els.reportFioInput) els.reportFioInput.value = "";
          if (els.reportSignatureInput) els.reportSignatureInput.value = "";
          if (els.reportDateInput) els.reportDateInput.value = state.reportMeta.date;
          state.promotion.posts = {};
          state.sanctions.posts = {};
          renderPromotionView();
          renderSanctionView();
          showToast("Локальное состояние очищено", "amber");
        }
      });
    }

    // Модальные окна
    els.confirmModalCancel.addEventListener("click", () => {
      els.confirmModal.classList.remove("active");
    });

    els.confirmModalProceed.addEventListener("click", () => {
      const section = els.confirmModal.dataset.section || state.activeTab;
      const criterionIdx = els.confirmModal.dataset.criterionIdx || "all";
      executeBatchUpload(section, criterionIdx);
    });

    els.progressModalCancel.addEventListener("click", () => {
      state.upload.isUploading = false;
      els.progressModal.classList.remove("active");
      showToast("Загрузка прервана пользователем", "amber");
    });
  }

  // Запуск при готовности DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();