import { saveChat, reloadCurrentChat } from "../../../../script.js";

const extensionName = "st-chat-finder";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const positionStorageKey = `${extensionName}.panelPosition`;
const panelMargin = 8;
const inputDebounceMs = 500;
const renderedRefreshDebounceMs = 140;
const searchBatchSize = 50;

let searchResults = [];
let currentResultIndex = -1;
let searchTimer = 0;
let renderedRefreshTimer = 0;
let navigationRequestId = 0;
let searchRequestId = 0;

/**
 * Load the panel once, then attach it to the extensions wand menu.
 */
jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);
    const $settingsHtml = $(settingsHtml);
    $("#extensionsMenu").append($settingsHtml.filter("#finder_menu_item"));
    $(document.body).append($settingsHtml.filter("#finder_panel"));

    $("#finder_menu_item").on("click", () => {
        togglePanel();
        $("#extensionsMenuButton").trigger("click");
    });
    $("#finder_btn_close").on("click", closePanel);
    $("#finder_btn_find").on("click", performSearch);
    $("#finder_btn_next").on("click", () => navigateMatch(1));
    $("#finder_btn_prev").on("click", () => navigateMatch(-1));
    $("#finder_btn_replace_one").on("click", replaceCurrent);
    $("#finder_btn_replace_all").on("click", replaceAll);
    $("#finder_btn_clear_search").on("click", () => clearInput("#finder_input_search"));
    $("#finder_btn_clear_replace").on("click", () => clearInput("#finder_input_replace"));
    $("#finder_input_search").on("input", scheduleSearch);
    $("#finder_case_sensitive, #finder_regex, #finder_limit_range").on("change", () => {
        updateRangeControls();
        scheduleSearch();
    });
    $("#finder_range_from, #finder_range_to").on("input", scheduleSearch);

    $("#finder_input_search").on("keypress", (event) => {
        if (event.which === 13) performSearch();
    });

    setupPanelDragging();
    setupChatEvents();
    updateRangeControls();
    const repositionPanelForViewport = () => {
        if ($("#finder_panel").prop("hidden")) return;
        restorePanelPosition();
        clampPanelPosition(false);
    };
    window.addEventListener("resize", repositionPanelForViewport, { passive: true });
    window.visualViewport?.addEventListener("resize", repositionPanelForViewport, { passive: true });
});

function getChat() {
    return SillyTavern.getContext().chat;
}

function getSearchText() {
    return String($("#finder_input_search").val() || "");
}

function clearInput(selector) {
    $(selector).val("").trigger("input").trigger("focus");
}

function getSearchRegex() {
    const searchText = getSearchText();
    if (!searchText) return null;

    const isRegex = $("#finder_regex").is(":checked");
    const isCaseSensitive = $("#finder_case_sensitive").is(":checked");
    const flags = isCaseSensitive ? "g" : "gi";

    try {
        const pattern = isRegex
            ? searchText
            : searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(pattern, flags);
    } catch (error) {
        $("#finder_status").text("Invalid Regex pattern");
        return null;
    }
}

function scheduleSearch() {
    window.clearTimeout(searchTimer);
    searchRequestId += 1;
    navigationRequestId += 1;
    clearHighlights();
    searchResults = [];
    currentResultIndex = -1;
    $("#finder_status").text(getSearchText() ? "Waiting to search..." : "Type to highlight matches");
    searchTimer = window.setTimeout(performSearch, inputDebounceMs);
}

function updateRangeControls() {
    const limitRange = $("#finder_limit_range").is(":checked");
    $("#finder_range_from, #finder_range_to").prop("disabled", !limitRange);
}

function setupChatEvents() {
    const context = SillyTavern.getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes;
    const refreshEvents = [
        eventTypes.MORE_MESSAGES_LOADED,
        eventTypes.CHAT_LOADED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_SENT,
        eventTypes.MESSAGE_RECEIVED,
    ].filter(Boolean);

    refreshEvents.forEach((eventName) => eventSource.on(eventName, scheduleRenderedRefresh));
}

function scheduleRenderedRefresh() {
    if ($("#finder_panel").prop("hidden") || !getSearchText()) return;

    window.clearTimeout(renderedRefreshTimer);
    renderedRefreshTimer = window.setTimeout(() => {
        renderedRefreshTimer = 0;
        refreshRenderedHighlights();
    }, renderedRefreshDebounceMs);
}

function refreshRenderedHighlights() {
    const regex = getSearchRegex();
    if (!regex || searchResults.length === 0) return;

    const activeResult = searchResults[currentResultIndex];
    clearHighlights();
    const highlightedMessages = new Set(searchResults.map((result) => result.chatIndex));
    highlightedMessages.forEach((chatIndex) => highlightMessage(chatIndex, regex));

    const activeMessage = getMessageElement(activeResult?.chatIndex);
    activeMessage?.classList.add("finder-highlight-message");
    const activeHighlight = getMessageHighlights(activeResult);
    activeHighlight?.classList.add("finder-active-highlight");
}

async function performSearch() {
    window.clearTimeout(searchTimer);
    searchTimer = 0;
    const requestId = ++searchRequestId;
    navigationRequestId += 1;
    clearHighlights();
    searchResults = [];
    currentResultIndex = -1;

    const chat = getChat();
    const regex = getSearchRegex();
    if (!regex) {
        $("#finder_status").text(getSearchText() ? "Invalid search pattern" : "Type to highlight matches");
        return;
    }

    if (!Array.isArray(chat) || chat.length === 0) {
        $("#finder_status").text("Chat is empty or not loaded");
        return;
    }

    const range = getSearchRange(chat.length);
    if (!range) return;

    $("#finder_status").text(`Searching messages ${range.start}-${range.end}...`);
    const nextResults = [];
    for (let chatIndex = range.start; chatIndex <= range.end; chatIndex += 1) {
        if (requestId !== searchRequestId) return;

        const message = chat[chatIndex];
        if (!message?.mes) continue;

        const matchCount = countMatches(message.mes, regex);
        for (let occurrenceIndex = 0; occurrenceIndex < matchCount; occurrenceIndex += 1) {
            nextResults.push({ chatIndex, occurrenceIndex });
        }

        if ((chatIndex - range.start + 1) % searchBatchSize === 0) await awaitBrowserTurn();
    }

    if (requestId !== searchRequestId) return;
    searchResults = nextResults;
    const highlightedMessages = new Set(searchResults.map((result) => result.chatIndex));
    highlightedMessages.forEach((chatIndex) => highlightMessage(chatIndex, regex));

    if (searchResults.length > 0) {
        currentResultIndex = 0;
        void setActiveResult();
        updateStatusText();
    } else {
        $("#finder_status").text("No matches found");
    }
}

function getSearchRange(chatLength) {
    if (!$("#finder_limit_range").is(":checked")) {
        return { start: 0, end: chatLength - 1 };
    }

    const fromText = String($("#finder_range_from").val() || "").trim();
    const toText = String($("#finder_range_to").val() || "").trim();
    const from = fromText ? Number(fromText) : 0;
    const to = toText ? Number(toText) : chatLength;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || from >= chatLength) {
        $("#finder_status").text("Enter a valid message range");
        return null;
    }

    return {
        start: from,
        end: Math.min(to, chatLength - 1),
    };
}

function awaitBrowserTurn() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function countMatches(text, regex) {
    let count = 0;
    regex.lastIndex = 0;

    while (regex.exec(text) !== null) {
        count += 1;
        if (regex.lastIndex === 0) regex.lastIndex += 1;
    }

    regex.lastIndex = 0;
    return count;
}

function getMessageElement(chatIndex) {
    const messageSelector = `#chat .mes[mesid="${chatIndex}"]`;
    return document.querySelector(messageSelector);
}

function getMessageContentElement(messageElement) {
    return messageElement?.querySelector(".mes_text");
}

function getMessageHighlights(result) {
    if (!result) return null;
    return getMessageElement(result.chatIndex)?.querySelectorAll(".finder-text-highlight")?.[result.occurrenceIndex] || null;
}

function waitForMoreMessagesLoaded() {
    const context = SillyTavern.getContext();
    const eventName = context.eventTypes?.MORE_MESSAGES_LOADED;
    if (!eventName || !context.eventSource?.once) return Promise.resolve();

    return new Promise((resolve) => {
        const timeout = window.setTimeout(resolve, 1000);
        context.eventSource.once(eventName, () => {
            window.clearTimeout(timeout);
            resolve();
        });
    });
}

async function ensureMessageRendered(chatIndex) {
    let messageElement = getMessageElement(chatIndex);
    let attempts = 0;

    while (!messageElement && attempts < 100) {
        const firstRenderedId = Number(document.querySelector("#chat .mes")?.getAttribute("mesid"));
        const showMoreButton = document.querySelector("#show_more_messages");
        if (!showMoreButton || (Number.isFinite(firstRenderedId) && chatIndex >= firstRenderedId)) break;

        const loadPromise = waitForMoreMessagesLoaded();
        showMoreButton.click();
        await loadPromise;
        messageElement = getMessageElement(chatIndex);
        attempts += 1;
    }

    return messageElement;
}

function highlightMessage(chatIndex, regex) {
    const messageElement = getMessageElement(chatIndex);
    const contentElement = getMessageContentElement(messageElement);
    if (!contentElement) return;

    const walker = document.createTreeWalker(contentElement, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeValue && regex.test(node.nodeValue)) textNodes.push(node);
        regex.lastIndex = 0;
    }

    textNodes.forEach((textNode) => wrapMatches(textNode, regex));
}

function wrapMatches(textNode, regex) {
    const text = textNode.nodeValue;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
        if (match[0] === "") {
            regex.lastIndex += 1;
            continue;
        }

        fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
        const highlight = document.createElement("mark");
        highlight.className = "finder-text-highlight";
        highlight.textContent = match[0];
        fragment.append(highlight);
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex === 0) return;
    fragment.append(document.createTextNode(text.slice(lastIndex)));
    textNode.replaceWith(fragment);
}

function clearHighlights() {
    document.querySelectorAll("#chat .finder-text-highlight").forEach((highlight) => {
        highlight.replaceWith(document.createTextNode(highlight.textContent));
    });
    document.querySelectorAll("#chat .mes_text").forEach((contentElement) => {
        contentElement.normalize();
    });
    document.querySelectorAll("#chat .finder-highlight-message").forEach((message) => {
        message.classList.remove("finder-highlight-message");
    });
}

function navigateMatch(direction) {
    if (searchResults.length === 0) return;

    currentResultIndex = (currentResultIndex + direction + searchResults.length) % searchResults.length;
    void setActiveResult();
    updateStatusText();
}

async function setActiveResult() {
    const result = searchResults[currentResultIndex];
    const requestId = ++navigationRequestId;
    document.querySelectorAll("#chat .finder-highlight-message").forEach((message) => {
        message.classList.remove("finder-highlight-message");
    });

    const messageElement = await ensureMessageRendered(result.chatIndex);
    if (requestId !== navigationRequestId) return;
    if (!messageElement) return;

    refreshRenderedHighlights();
    messageElement.classList.add("finder-highlight-message");
    const activeHighlight = getMessageHighlights(result);
    revealHighlightAncestors(activeHighlight);
    activeHighlight?.classList.add("finder-active-highlight");
    (activeHighlight || messageElement).scrollIntoView({ behavior: "smooth", block: "center" });
}

function revealHighlightAncestors(highlight) {
    if (!highlight) return;

    highlight.querySelectorAll?.(".sb-accordion-body:not(.sb-open)").forEach((body) => {
        openAccordionBody(body);
    });

    let body = highlight.closest(".sb-accordion-body");
    while (body) {
        if (!body.classList.contains("sb-open")) openAccordionBody(body);
        body = body.parentElement?.closest(".sb-accordion-body") || null;
    }
}

function openAccordionBody(body) {
    const header = body.previousElementSibling?.closest?.(".sb-accordion-header");
    if (header) {
        header.click();
        return;
    }

    body.classList.add("sb-open");
}

function updateStatusText() {
    const result = searchResults[currentResultIndex];
    $("#finder_status").text(`Message ${result.chatIndex}, match ${result.occurrenceIndex + 1} | ${currentResultIndex + 1} of ${searchResults.length}`);
}

async function replaceCurrent() {
    if (currentResultIndex < 0 || searchResults.length === 0) return;

    const chat = getChat();
    const regex = getSearchRegex();
    const replacement = String($("#finder_input_replace").val() || "");
    const result = searchResults[currentResultIndex];
    const chatIndex = result.chatIndex;
    if (!regex || !chat?.[chatIndex]?.mes) return;

    const original = chat[chatIndex].mes;
    const modified = original.replace(regex, replacement);
    if (original === modified) {
        $("#finder_status").text("Match lost or already replaced");
        return;
    }

    chat[chatIndex].mes = modified;
    await saveChat();
    await reloadCurrentChat();
    performSearch();
    toastr.success("Replaced match");
}

async function replaceAll() {
    const chat = getChat();
    const regex = getSearchRegex();
    const replacement = String($("#finder_input_replace").val() || "");
    if (!regex || !Array.isArray(chat) || chat.length === 0) return;
    if (!confirm("Replace ALL occurrences in the entire chat? Cannot be undone.")) return;

    let changesCount = 0;
    chat.forEach((message) => {
        if (!message?.mes) return;
        regex.lastIndex = 0;
        const modified = message.mes.replace(regex, replacement);
        if (message.mes !== modified) {
            message.mes = modified;
            changesCount += 1;
        }
    });

    if (changesCount === 0) {
        $("#finder_status").text("No matches found");
        return;
    }

    await saveChat();
    await reloadCurrentChat();
    performSearch();
    toastr.success(`Replaced in ${changesCount} messages`);
}

function togglePanel() {
    const panel = $("#finder_panel");
    if (panel.prop("hidden")) {
        panel.prop("hidden", false);
        restorePanelPosition();
        clampPanelPosition(false);
        $("#finder_input_search").trigger("focus");
    } else {
        closePanel();
    }
}

function closePanel() {
    $("#finder_panel").prop("hidden", true);
    clearHighlights();
}

function getDeviceKey() {
    return window.matchMedia("(max-width: 600px)").matches ? "mobile" : "desktop";
}

function getStoredPositions() {
    try {
        return JSON.parse(localStorage.getItem(positionStorageKey) || "{}");
    } catch (error) {
        return {};
    }
}

function restorePanelPosition() {
    const position = getStoredPositions()[getDeviceKey()];
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        const panel = document.getElementById("finder_panel");
        panel.style.left = `${position.left}px`;
        panel.style.top = `${position.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        return;
    }

    const panel = document.getElementById("finder_panel");
    panel.style.left = `${Math.max(panelMargin, window.innerWidth - panel.offsetWidth - 18)}px`;
    panel.style.top = `${Math.max(panelMargin, window.innerHeight - panel.offsetHeight - 80)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
}

function clampPanelPosition(savePosition) {
    const panel = document.getElementById("finder_panel");
    if (!panel || panel.hidden) return;

    const maxLeft = Math.max(panelMargin, window.innerWidth - panel.offsetWidth - panelMargin);
    const maxTop = Math.max(panelMargin, window.innerHeight - panel.offsetHeight - panelMargin);
    const left = Math.max(panelMargin, Math.min(parseFloat(panel.style.left) || 0, maxLeft));
    const top = Math.max(panelMargin, Math.min(parseFloat(panel.style.top) || 0, maxTop));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    if (savePosition) {
        const positions = getStoredPositions();
        positions[getDeviceKey()] = { left, top };
        try {
            localStorage.setItem(positionStorageKey, JSON.stringify(positions));
        } catch (error) {
            // Position persistence is optional and must never interrupt dragging.
        }
    }
}

function setupPanelDragging() {
    const header = document.getElementById("finder_panel_header");
    const panel = document.getElementById("finder_panel");
    if (!header || !panel) return;

    let dragState = null;
    header.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button")) return;
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: parseFloat(panel.style.left) || panel.offsetLeft,
            top: parseFloat(panel.style.top) || panel.offsetTop,
        };
        header.setPointerCapture(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        panel.style.left = `${dragState.left + event.clientX - dragState.startX}px`;
        panel.style.top = `${dragState.top + event.clientY - dragState.startY}px`;
        clampPanelPosition(false);
    });

    const stopDragging = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        clampPanelPosition(true);
        dragState = null;
    };
    header.addEventListener("pointerup", stopDragging);
    header.addEventListener("pointercancel", stopDragging);
}