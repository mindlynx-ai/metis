/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The one editor every long-form field uses: code, SQL, JSON bodies, HTML.
 *
 * A plain textarea gave none of what writing code needs - no line numbers, no
 * highlighting, no indentation, no bracket matching - and a line number is
 * exactly what an error message hands you.
 *
 * CodeMirror rather than Monaco, decided on numbers: Monaco is 93 MB installed
 * against roughly 5 MB, in a repository that made a 60 MB SQL driver optional
 * over the same argument. Monaco's headline feature is TypeScript IntelliSense,
 * and Metis strips types rather than checking them, so it would have flagged
 * errors the runtime never enforces.
 *
 * TWO THINGS TO KNOW BEFORE CHANGING ANYTHING HERE.
 *
 * 1. It is a CONTROLLED component over a `contenteditable`, not an input. The
 *    host owns the string and commits on every keystroke (SetupPanel has no
 *    blur-commit). `value` arriving different from the document means the host
 *    changed it - a different step selected - so the document is replaced;
 *    echoing our own change back would fight the cursor.
 * 2. It is NOT a textarea, so the variable palette's DOM insert cannot reach it
 *    (see insert-reference.ts). It registers an imperative handle while focused
 *    instead. Without that, every `{{...}}` chip silently degrades to "copied to
 *    the clipboard".
 */
import { useEffect, useRef } from 'react';
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutterLineClass,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { registerInsertHandle } from './insert-reference.js';

/** Which grammar to use. `text` means no grammar, just the editing affordances. */
export type EditorLanguage = 'javascript' | 'python' | 'sql' | 'json' | 'html' | 'text';

function grammarFor(language: EditorLanguage): Extension[] {
  switch (language) {
    case 'javascript':
      return [javascript()];
    case 'python':
      return [python()];
    case 'sql':
      return [sql()];
    case 'json':
      return [json()];
    case 'html':
      // autoCloseTags off. It inserts a closing tag as you type the opening
      // one, so anyone typing complete HTML - which is what an email body is -
      // ends up with `</p></p>`. Helpful in a page editor, surprising in a
      // field where people paste markup they already have.
      return [html({ autoCloseTags: false })];
    default:
      return [];
  }
}

/**
 * Colours come from the product's own tokens rather than a bundled theme, so
 * light and dark follow the app and nothing new has to be kept in step. The
 * token names are read at paint time by the browser, so a theme switch needs no
 * editor rebuild.
 */
const metisTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface-base)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '8px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-sunken)',
    color: 'var(--text-faint)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--brand-wash)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--brand-wash)', color: 'var(--text-muted)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--brand-wash)' },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.55' },
});

/**
 * The failing line, held in editor state so it survives re-renders and moves
 * with the document if lines are inserted above it.
 */
const setErrorLine = StateEffect.define<number | undefined>();

const errorLineField = StateField.define<number | undefined>({
  create: () => undefined,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setErrorLine)) return effect.value;
    }
    // Any edit clears it. A marker that outlives the mistake it describes is
    // the same species of lie as a line number that is two out.
    return transaction.docChanged ? undefined : current;
  },
});

const errorLineDecoration = Decoration.line({ class: 'cm-error-line' });

const errorLineHighlight = EditorView.decorations.compute([errorLineField], (state) => {
  const line = state.field(errorLineField);
  if (!line || line > state.doc.lines) return Decoration.none;
  return Decoration.set([errorLineDecoration.range(state.doc.line(line).from)]) as DecorationSet;
});

/** The gutter wants a GutterMarker, not a Decoration - different range set. */
const errorGutterMarker = new (class extends GutterMarker {
  elementClass = 'cm-error-gutter';
})();

const errorGutterClass = gutterLineClass.compute([errorLineField], (state) => {
  const line = state.field(errorLineField);
  if (!line || line > state.doc.lines) return RangeSet.empty;
  return RangeSet.of([errorGutterMarker.range(state.doc.line(line).from)]);
});

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language?: EditorLanguage;
  /** Rows of content before it scrolls. Small fields should stay small. */
  minLines?: number;
  maxLines?: number;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  /** 1-based line the last run failed on; cleared as soon as it is edited. */
  errorLine?: number;
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  minLines = 6,
  maxLines = 20,
  placeholder,
  ariaLabel,
  id,
  errorLine,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // The latest onChange, read from inside CodeMirror's listener. Without this
  // the extension would close over the first render's callback for ever.
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return undefined;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          errorLineField,
          errorLineHighlight,
          errorGutterClass,
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          ...grammarFor(language),
          metisTheme,
          EditorView.lineWrapping,
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          EditorView.contentAttributes.of({
            ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
            ...(id ? { id } : {}),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Rebuilt only when the GRAMMAR changes - a code step switching language.
    // `value` is deliberately NOT a dependency: rebuilding the editor on every
    // keystroke would destroy the cursor. Outside changes are reconciled by the
    // effect below instead. `placeholder`, `ariaLabel` and `id` are read once at
    // construction and never change for a given field.
  }, [language]);

  // Reconcile an outside change - a different step selected, a reset - without
  // disturbing the caret while somebody is typing.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  // Mark whichever line the last run blamed.
  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  // The variable palette's route in. A contenteditable cannot take the DOM
  // insert that inputs and textareas do, so hand it a real one for as long as
  // this editor holds focus.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return undefined;
    const insert = (text: string) => {
      const { from, to } = editor.state.selection.main;
      editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      editor.focus();
    };
    const claim = () => registerInsertHandle(insert);
    const release = () => registerInsertHandle(undefined, insert);
    editor.contentDOM.addEventListener('focusin', claim);
    editor.contentDOM.addEventListener('focusout', release);
    return () => {
      editor.contentDOM.removeEventListener('focusin', claim);
      editor.contentDOM.removeEventListener('focusout', release);
      release();
    };
  }, []);

  return (
    <div
      ref={host}
      className="code-editor"
      style={{
        // Lines, not pixels: a two-line JSON field should not open as a slab.
        minHeight: `${minLines * 1.55}em`,
        maxHeight: `${maxLines * 1.55}em`,
      }}
    />
  );
}
