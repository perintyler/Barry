import { renderCsvTable } from './artifact-format.js';

/** CSV/TSV rendered as a real table. */
export function renderTable(container, doc, opts = {}) {
  const { classes = {} } = opts;

  const wrapper = document.createElement('div');
  wrapper.className = classes.csvWrapper || 'artifacts-app-csv-wrapper';
  wrapper.innerHTML = renderCsvTable(typeof doc.content === 'string' ? doc.content : '', {
    isTsv: (doc.type || '').toLowerCase() === 'tsv',
    tableClass: classes.csvTable || 'artifacts-app-csv-table',
  });

  container.appendChild(wrapper);
  return wrapper;
}
