import { extension_settings } from "../../../extensions.js";
import { saveChat, reloadCurrentChat } from "../../../../script.js";

const extensionName = "st-chat-finder";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Состояние поиска
let searchResults = []; 
let currentResultIndex = -1;

/**
 * Загрузка интерфейса
 */
jQuery(async () => {
    // Загружаем HTML
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);
    $("#extensions_settings").append(settingsHtml);

    // Привязываем события к кнопкам
    $("#finder_btn_find").on("click", performSearch);
    $("#finder_btn_next").on("click", () => navigateMatch(1));
    $("#finder_btn_prev").on("click", () => navigateMatch(-1));
    $("#finder_btn_replace_one").on("click", replaceCurrent);
    $("#finder_btn_replace_all").on("click", replaceAll);

    // Событие нажатия Enter в поле поиска
    $("#finder_input_search").on("keypress", (e) => {
        if (e.which === 13) performSearch();
    });
});

/**
 * Вспомогательная функция для получения текущего чата из контекста SillyTavern
 */
function getChat() {
    // SillyTavern.getContext() возвращает глобальный объект, где лежит массив chat
    const context = SillyTavern.getContext();
    return context.chat;
}

/**
 * Создание регулярного выражения на основе настроек
 */
function getSearchRegex() {
    const searchText = $("#finder_input_search").val();
    if (!searchText) return null;

    const isRegex = $("#finder_regex").is(":checked");
    const isCaseSensitive = $("#finder_case_sensitive").is(":checked");
    const flags = isCaseSensitive ? "g" : "gi";

    try {
        if (isRegex) {
            return new RegExp(searchText, flags);
        } else {
            // Экранируем спецсимволы
            const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(escaped, flags);
        }
    } catch (e) {
        toastr.error("Invalid Regex pattern");
        return null;
    }
}

/**
 * Выполнение поиска по чату
 */
function performSearch() {
    const chat = getChat(); // Получаем чат правильно

    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.warning("Chat is empty or not loaded");
        return;
    }

    const regex = getSearchRegex();
    if (!regex) return;

    searchResults = [];
    currentResultIndex = -1;

    // Проходимся по всем сообщениям
    chat.forEach((msg, index) => {
        if (msg.mes && msg.mes.match(regex)) {
            searchResults.push(index);
        }
    });

    if (searchResults.length > 0) {
        currentResultIndex = 0;
        scrollToCurrentMatch();
        updateStatusText();
        toastr.success(`Found ${searchResults.length} matches.`);
    } else {
        $("#finder_status").text("No matches found.");
        toastr.info("No matches found.");
    }
}

/**
 * Навигация по результатам (Next/Prev)
 */
function navigateMatch(direction) {
    if (searchResults.length === 0) return;

    currentResultIndex += direction;

    if (currentResultIndex >= searchResults.length) currentResultIndex = 0;
    if (currentResultIndex < 0) currentResultIndex = searchResults.length - 1;

    scrollToCurrentMatch();
    updateStatusText();
}

/**
 * Прокрутка к сообщению и подсветка
 */
function scrollToCurrentMatch() {
    $(".finder-highlight-message").removeClass("finder-highlight-message");

    const chatIndex = searchResults[currentResultIndex];
    // Ищем элемент сообщения по атрибуту mesid (это надежнее всего в ST)
    // Либо по порядку, если атрибутов нет
    let $msgElement = $(`#chat .mes[mesid="${chatIndex}"]`);
    
    // Фоллбэк: если mesid не найден или не совпадает, берем по индексу DOM
    if ($msgElement.length === 0) {
        $msgElement = $(`#chat .mes`).eq(chatIndex);
    }

    if ($msgElement.length) {
        $msgElement[0].scrollIntoView({ behavior: "smooth", block: "center" });
        $msgElement.addClass("finder-highlight-message");
        
        setTimeout(() => {
            $msgElement.removeClass("finder-highlight-message");
        }, 2000);
    }
}

function updateStatusText() {
    $("#finder_status").text(`Match ${currentResultIndex + 1} of ${searchResults.length}`);
}

/**
 * Замена текущего совпадения
 */
async function replaceCurrent() {
    if (currentResultIndex === -1 || searchResults.length === 0) return;

    const chat = getChat();
    const chatIndex = searchResults[currentResultIndex];
    const replacement = $("#finder_input_replace").val();
    const regex = getSearchRegex(); 

    if (!regex) return;

    let messageContent = chat[chatIndex].mes;
    
    // Заменяем
    const newMessageContent = messageContent.replace(regex, replacement);

    if (messageContent !== newMessageContent) {
        chat[chatIndex].mes = newMessageContent;
        
        await saveChat();
        await reloadCurrentChat();
        
        toastr.success("Replaced match.");
        // Перезапускаем поиск, чтобы обновить индексы
        performSearch(); 
    } else {
        toastr.warning("Match lost or already replaced.");
    }
}

/**
 * Замена всех совпадений
 */
async function replaceAll() {
    const chat = getChat();
    const regex = getSearchRegex();
    const replacement = $("#finder_input_replace").val();
    
    if (!regex) return;
    if (!Array.isArray(chat) || chat.length === 0) return;

    if (!confirm("Replace ALL occurrences in the entire chat? Cannot be undone.")) return;

    let changesCount = 0;

    chat.forEach((msg) => {
        if (msg.mes) {
            const original = msg.mes;
            // .replace с флагом g (глобально) заменит все вхождения в строке
            const modified = original.replace(regex, replacement);
            
            if (original !== modified) {
                msg.mes = modified;
                changesCount++;
            }
        }
    });

    if (changesCount > 0) {
        await saveChat();
        await reloadCurrentChat();
        toastr.success(`Replaced in ${changesCount} messages.`);
        
        searchResults = [];
        currentResultIndex = -1;
        $("#finder_status").text("Replacement complete.");
    } else {
        toastr.info("No matches found.");
    }
}