import type { Retro } from '../types';
import { Details } from './common';
import { Markdown } from './Markdown';

/** A weekly retro's numbers and recommendations (`retro` on its chat line), with the full write-up behind a toggle. */
export function RetroBlock({ retro, text }: { retro: Retro; text: string }) {
  return (
    <div className="retro">
      <b>Weekly retro{retro.week ? ` · ${retro.week}` : ''}</b>
      {retro.metrics.length ? (
        <table className="retro-metrics">
          <tbody>
            {retro.metrics.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                <td>{m.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {retro.recommendations.length ? (
        <>
          <span className="retro-h">Next week</span>
          <ul>
            {retro.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      ) : null}
      {text.trim() ? (
        <Details label="Full retro" openLabel="Hide the full retro">
          <Markdown text={text} />
        </Details>
      ) : null}
    </div>
  );
}
