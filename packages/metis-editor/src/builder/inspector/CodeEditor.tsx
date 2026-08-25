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
 * Monaco, the editor from VS Code. It costs about 4 MB in the bundle and a
 * large install, and buys editing people already know: multiple cursors, the
 * command palette, real find and replace, completion for the language's own
 * built-ins.
 *
 * WHAT IT IS DELIBERATELY NOT DOING, and this is the important part: its
 * built-in JavaScript diagnostics are OFF. Those are TypeScript's, run in the
 * browser, against the browser's idea of JavaScript - they pass `fetch(...)`
 * and `require(...)`, neither of which exists in this sandbox, and they refuse
 * top-level `return` and `await`, which is how every step here is written. An
 * editor that disagrees with the runtime teaches people to distrust the
 * runtime. Errors come from `POST /api/code/validate` instead, which asks the
 * same V8 and CPython that will run the step. Python has no browser-side
 * diagnostics at all, so this is also the only way both languages get the same
 * answer.
 *
 * TWO THINGS TO KNOW BEFORE CHANGING ANYTHING HERE.
 *
 * 1. It is a CONTROLLED component. The host owns the string and commits on
 *    every keystroke (there is no blur-commit). A `value` arriving different
 *    from the model means the host changed it - a different step selected - so
 *    the model is replaced; echoing our own change back would fight the cursor.
 * 2. Its focusable element is a hidden textarea Monaco owns. That would PASS
 *    the variable palette's `isReferenceTarget` check and then swallow the
 *    insert, because the model is the source of truth and not that textarea. It
 *    registers an imperative handle instead, and the guard excludes Monaco's
 *    input explicitly.
 */
import { useEffect, useRef } from 'react';
// The CORE api and five tokenizers, not the `monaco-editor` barrel.
//
// The barrel pulls in every language FEATURE, and each feature drags its web
// worker: importing it whole produced a 15 MB build of which 9 MB was
// ts.worker, css.worker, html.worker and json.worker. Those workers exist to
// provide diagnostics in the browser - the one thing this editor deliberately
// does not do, because the browser's idea of JavaScript is not this sandbox's
// and it has no idea about Python at all. Errors come from the engine.
//
// So: the api, and tokenizers for colouring. Nothing that thinks.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/html/register';
import { registerInsertHandle } from './insert-reference.js';

// The editor API, on the window, the way the standalone build has always
// offered it. It is how the end-to-end tests read and set an editor's value:
// through the MODEL, which is this component's source of truth, rather than
// through keystrokes. Typing into Monaco is not a way to set a value - it
// auto-closes brackets and quotes, so `{"a":"b"}` typed character by character
// arrives as something else entirely. There is nothing private here; it is the
// same object every Monaco page exposes, and a console handle for anyone
// debugging a field.
(globalThis as unknown as { monaco?: typeof monaco }).monaco = monaco;

/** Which grammar to use. `text` means none, just the editing affordances. */
export type EditorLanguage = 'javascript' | 'python' | 'sql' | 'json' | 'html' | 'text';

/** A problem to underline, in the author's own line numbers. */
export interface EditorMarker {
  line: number;
  column?: number;
  message: string;
}

const MONACO_LANGUAGE: Record<EditorLanguage, string> = {
  javascript: 'javascript',
  python: 'python',
  sql: 'sql',
  // JSON coloured by the JavaScript tokenizer. Monaco ships no standalone JSON
  // tokenizer - it only comes with the language FEATURE and its 400 KB worker,
  // whose job is the validation we deliberately do not do in the browser. JSON
  // is a subset of JavaScript's literal syntax, so the colours are right and
  // the worker is not shipped.
  json: 'javascript',
  html: 'html',
  text: 'plaintext',
};

/** Ours, not Monaco's: the markers we own must not clobber anything else. */
const MARKER_OWNER = 'metis';

let configured = false;

/**
 * One-time theme setup.
 *
 * There are no checkers to silence: the language features that would have done
 * the checking are simply not imported. That is not a saving trick - teaching
 * TypeScript about this sandbox (no DOM, no require, no fetch, top-level
 * return and await) is a lot of configuration to arrive somewhere less accurate
 * than asking the engine, and Python would still have nothing.
 */
function configureMonaco(): void {
  if (configured) return;
  configured = true;

  // Colours read from the product's own tokens so the editor follows the app.
  // Monaco needs literal hex, so they are resolved from the document at define
  // time and redefined whenever the theme changes.
  for (const [name, base] of [
    ['metis-light', 'vs'],
    ['metis-dark', 'vs-dark'],
  ] as const) {
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: [],
      colors: {},
    });
  }
}

/** The theme that matches the app right now. */
function currentTheme(): string {
  return document.documentElement.dataset.theme === 'dark' ? 'metis-dark' : 'metis-light';
}

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language?: EditorLanguage;
  /** Lines of content before it scrolls. Small fields should stay small. */
  minLines?: number;
  maxLines?: number;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  /** Problems to underline. Cleared by the host when the code changes. */
  markers?: EditorMarker[];
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
  markers,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The latest onChange, read from inside Monaco's listener; without this it
  // would close over the first render's callback for ever.
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return undefined;
    configureMonaco();
    const created = monaco.editor.create(host.current, {
      value,
      language: MONACO_LANGUAGE[language],
      theme: currentTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      folding: true,
      wordWrap: 'on',
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      renderLineHighlight: 'line',
      scrollbar: { alwaysConsumeMouseWheel: false },
      placeholder,
      ariaLabel,
    });
    editor.current = created;
    const listener = created.onDidChangeModelContent(() => {
      emit.current(created.getValue());
    });
    // Monaco fills its container, so the container has to have a height. Grow
    // with the content between the two bounds rather than picking one number:
    // the same widget holds a two-line JSON body and a fifty-line program, and
    // a fixed height is wrong for one of them.
    const lineHeight = created.getOption(monaco.editor.EditorOption.lineHeight);
    const resize = () => {
      if (!host.current) return;
      const wanted = created.getContentHeight() + lineHeight;
      const height = Math.min(Math.max(wanted, minLines * lineHeight), maxLines * lineHeight);
      host.current.style.height = `${height}px`;
      created.layout();
    };
    const sizeListener = created.onDidContentSizeChange(resize);
    resize();
    return () => {
      sizeListener.dispose();
      listener.dispose();
      created.getModel()?.dispose();
      created.dispose();
      editor.current = null;
    };
    // Rebuilt only when the GRAMMAR changes. `value` is deliberately absent:
    // rebuilding on every keystroke would destroy the cursor. Outside changes
    // are reconciled below instead.
  }, [language]);

  // Reconcile an outside change without disturbing the caret mid-typing.
  useEffect(() => {
    const live = editor.current;
    if (!live || live.getValue() === value) return;
    live.setValue(value);
  }, [value]);

  // Follow the app's theme. Monaco themes are global, so this is a set, not a
  // rebuild, and every editor on the page follows.
  useEffect(() => {
    const apply = () => monaco.editor.setTheme(currentTheme());
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);

  // Underline whatever the engine said was wrong.
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      (markers ?? []).map((marker) => ({
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: marker.line,
        endLineNumber: marker.line,
        startColumn: marker.column ?? 1,
        // To the end of the line: a parser's column is where it gave up, which
        // is rarely where the mistake starts, and a one-character squiggle is
        // easy to miss.
        endColumn: model.getLineMaxColumn(Math.min(marker.line, model.getLineCount())),
      })),
    );
  }, [markers]);

  // The variable palette's route in. Monaco's own textarea would swallow a DOM
  // insert, so hand over a real one for as long as this editor holds focus.
  useEffect(() => {
    const live = editor.current;
    if (!live) return undefined;
    const insert = (text: string) => {
      const selection = live.getSelection();
      if (selection) live.executeEdits('metis-insert', [{ range: selection, text, forceMoveMarkers: true }]);
      live.focus();
    };
    const claim = live.onDidFocusEditorText(() => registerInsertHandle(insert));
    const release = live.onDidBlurEditorText(() => registerInsertHandle(undefined, insert));
    return () => {
      claim.dispose();
      release.dispose();
      registerInsertHandle(undefined, insert);
    };
  }, []);

  return (
    <div
      ref={host}
      className="code-editor"
      data-editor-id={id}
      // Height is set imperatively from the content; this is the first paint
      // before Monaco has measured anything.
      style={{ height: `${minLines * 1.5}em` }}
    />
  );
}
