export class ArtifactList {
  constructor(container, { docs = [], selected = null, onselect = () => {} } = {}) {
    this.el = document.createElement('div');
    this.el.className = 'artifact-list';
    container.appendChild(this.el);

    this._docs = docs;
    this._filteredDocs = docs;
    this._selected = selected;
    this._onselect = onselect;
    this._query = '';
    this._openMenu = null;

    this._buildSearch();

    this._listEl = document.createElement('div');
    this._listEl.className = 'artifact-list-items';
    this.el.appendChild(this._listEl);

    this._render();

    // Close menu on outside click
    this._onDocClick = (e) => {
      if (this._openMenu && !this._openMenu.contains(e.target)) {
        this._closeMenu();
      }
    };
    document.addEventListener('click', this._onDocClick, true);
  }

  set docs(value) {
    this._docs = value;
    this._applyFilter();
  }

  _buildSearch() {
    const wrap = document.createElement('div');
    wrap.className = 'artifact-list-search';

    this._searchInput = document.createElement('input');
    this._searchInput.type = 'search';
    this._searchInput.placeholder = 'Search artifacts...';

    let debounceTimer;
    this._searchInput.oninput = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this._query = this._searchInput.value.trim().toLowerCase();
        this._applyFilter();
      }, 150);
    };

    wrap.appendChild(this._searchInput);
  }

  get itemCount() {
    return this._filteredDocs.length;
  }

  destroy() {
    document.removeEventListener('click', this._onDocClick, true);
    this.el.remove();
  }
}
