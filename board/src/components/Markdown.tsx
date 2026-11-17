import { useMemo, type MouseEvent } from 'react';
import { api } from '../lib/api';
import { copyText } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { toast } from '../lib/toast';
import { ui } from '../lib/ui';
import { useTaskKeys } from './common';

/** Escaped Markdown; known task keys open the task, code blocks get a Copy button, file chips open their file. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const keys = useTaskKeys();
  const html = useMemo(() => renderMarkdown(text, { taskKeys: keys }), [text, keys]);
  const onClick = async (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-task],[data-copy],[data-act]');
    if (!el) return;
    if (el.dataset.task) {
      ui.openTask(el.dataset.task);
      return;
    }
    const chip = el.dataset.act ? el.closest<HTMLElement>('.fchip') : null;
    if (chip) {
      const act = el.dataset.act;
      void api.openFile(chip.dataset.file ?? '', act === 'reveal').then(
        (r) => (act === 'open' && r.shown === 'revealed' ? toast('Shown in Finder: only documents open from the board.') : undefined),
        () => undefined,
      );
      return;
    }
    const code = el.parentElement?.querySelector('pre')?.textContent ?? '';
    if (await copyText(code)) {
      el.textContent = 'Copied';
      window.setTimeout(() => {
        el.textContent = 'Copy';
      }, 1500);
    } else toast('Copy failed', 'warn');
  };
  return <div className={className ? `md ${className}` : 'md'} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
