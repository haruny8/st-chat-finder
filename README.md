# Chat Finder & Replacer

This SillyTavern extension is a fork of [MorgoookRU/st-chat-finder](https://github.com/MorgoookRU/st-chat-finder).

It provides find and replace tools for the current chat, including case-sensitive searches, regular expressions, match navigation, and replacing one or all occurrences.

## What this fork adds

Compared with the original extension, this fork adds:

- A floating panel opened from the Extensions menu instead of an inline settings drawer.
- Highlighting for each matching occurrence, with a distinct highlight for the active match.
- Match results that track individual occurrences, not only messages containing a match.
- Automatic loading of older messages when navigating to a match that is not currently rendered.
- Highlight refreshes when messages are loaded, edited, sent, or received.
- A draggable, responsive panel whose position is remembered separately for desktop and mobile layouts.
- Clear buttons for the search and replacement fields, plus debounced searching while typing.
- An optional **Search message range** filter that limits searches to the specified `From` and `To` message bounds.

## Usage

1. Open the SillyTavern Extensions menu.
2. Select **Chat Finder & Replacer**.
3. Enter text to find, then use **Find**, **Previous Match**, or **Next Match**. Enable **Search message range** to limit the search with `From` and `To` message bounds.
4. Enter replacement text and use **Replace Current** or **Replace All**.

Replacements modify the chat and reload it automatically. **Replace All** asks for confirmation before changing the entire chat.