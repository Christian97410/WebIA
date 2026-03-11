import { h } from '../utils/dom.js';
import { api } from '../utils/api.js';

/**
 * Media panel: stock images/videos, AI image/video generation, local import.
 */
export class MediaPanel {
  constructor({ projectPath, onInsert, onClose }) {
    this.projectPath = projectPath;
    this.onInsert = onInsert; // (relativePath, type) => void
    this.onClose = onClose;
    this.providers = {};
    this.el = h('div', { className: 'media-panel' });
    this.tab = 'images'; // images | videos | ai | upload
    this.results = [];
    this.query = '';
    this.page = 1;
    this.loading = false;
    this.aiMode = 'image'; // image | video

    this.init();
  }

  async init() {
    try {
      this.providers = await api.get('/api/media/providers');
    } catch {}
    this.render();
  }

  render() {
    this.el.innerHTML = '';

    // Header
    this.el.appendChild(h('div', { className: 'mp-header' },
      h('span', { className: 'mp-title' }, 'Media'),
      h('button', { className: 'mp-close', onClick: () => this.onClose() }, '\u2715'),
    ));

    // Tabs
    const tabs = h('div', { className: 'mp-tabs' });
    for (const [key, label] of [['images', 'Images'], ['videos', 'Videos'], ['ai', 'AI'], ['upload', 'Import']]) {
      tabs.appendChild(h('button', {
        className: `mp-tab${this.tab === key ? ' active' : ''}`,
        onClick: () => { this.tab = key; this.results = []; this.query = ''; this.page = 1; this.render(); },
      }, label));
    }
    this.el.appendChild(tabs);

    // Content
    const content = h('div', { className: 'mp-content' });
    if (this.tab === 'images') this.renderStockImages(content);
    else if (this.tab === 'videos') this.renderStockVideos(content);
    else if (this.tab === 'ai') this.renderAI(content);
    else this.renderUpload(content);
    this.el.appendChild(content);
  }

  // ── Stock Images ──
  renderStockImages(wrap) {
    this._renderSearchBar(wrap, 'Search images...', () => this.searchImages());
    this.grid = h('div', { className: 'mp-grid' });
    wrap.appendChild(this.grid);
    this._renderLoadMore(wrap, () => { this.page++; this.searchImages(true); });
    this._renderProviderNotice(wrap, 'pixabay');
  }

  async searchImages(append = false) {
    if (!this.query || this.loading) return;
    this.loading = true;
    this.renderGridLoading();

    try {
      const data = await api.get(`/api/media/search/images?q=${encodeURIComponent(this.query)}&page=${this.page}`);
      if (append) this.results.push(...data.images);
      else this.results = data.images;
    } catch (err) {
      console.error('Image search failed:', err);
    }

    this.loading = false;
    this.renderImageGrid();
  }

  renderImageGrid() {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    if (this.results.length === 0 && this.query) {
      this.grid.appendChild(h('div', { className: 'mp-empty' }, 'No results'));
      return;
    }
    for (const img of this.results) {
      const item = h('div', { className: 'mp-grid-item' });
      item.appendChild(h('img', { src: img.thumb || img.preview, loading: 'lazy' }));
      const actions = h('div', { className: 'mp-grid-actions' });
      actions.appendChild(h('button', {
        onClick: () => this.downloadAndInsert(img.full || img.preview, `${img.source}-${img.id}.jpg`, 'image'),
      }, 'Use'));
      item.appendChild(actions);
      this.grid.appendChild(item);
    }
  }

  // ── Stock Videos ──
  renderStockVideos(wrap) {
    this._renderSearchBar(wrap, 'Search videos...', () => this.searchVideos());
    this.grid = h('div', { className: 'mp-grid mp-grid-video' });
    wrap.appendChild(this.grid);
    this._renderLoadMore(wrap, () => { this.page++; this.searchVideos(true); });
    this._renderProviderNotice(wrap, 'pixabay');
  }

  async searchVideos(append = false) {
    if (!this.query || this.loading) return;
    this.loading = true;
    this.renderGridLoading();

    try {
      const data = await api.get(`/api/media/search/videos?q=${encodeURIComponent(this.query)}&page=${this.page}`);
      if (append) this.results.push(...data.videos);
      else this.results = data.videos;
    } catch (err) {
      console.error('Video search failed:', err);
    }

    this.loading = false;
    this.renderVideoGrid();
  }

  renderVideoGrid() {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    if (this.results.length === 0 && this.query) {
      this.grid.appendChild(h('div', { className: 'mp-empty' }, 'No results'));
      return;
    }
    for (const vid of this.results) {
      const item = h('div', { className: 'mp-video-item' });

      // Preview on hover
      const thumb = h('img', { src: vid.thumbnail, loading: 'lazy' });
      item.appendChild(thumb);

      // Duration badge
      if (vid.duration) {
        const mins = Math.floor(vid.duration / 60);
        const secs = vid.duration % 60;
        item.appendChild(h('span', { className: 'mp-video-dur' }, `${mins}:${String(secs).padStart(2, '0')}`));
      }

      const actions = h('div', { className: 'mp-grid-actions' });
      actions.appendChild(h('button', {
        onClick: () => this.downloadAndInsert(vid.url, `${vid.source}-${vid.id}.mp4`, 'video'),
      }, 'Use'));
      item.appendChild(actions);

      // Hover to play preview
      item.addEventListener('mouseenter', () => {
        if (vid.url) {
          const video = h('video', { src: vid.url, muted: true, autoplay: true, loop: true });
          video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
          item.appendChild(video);
          item._hoverVideo = video;
        }
      });
      item.addEventListener('mouseleave', () => {
        if (item._hoverVideo) { item._hoverVideo.remove(); item._hoverVideo = null; }
      });

      this.grid.appendChild(item);
    }
  }

  // ── AI Generation (Image + Video) ──
  renderAI(wrap) {
    // Image / Video toggle
    const modeRow = h('div', { className: 'mp-tabs mp-ai-modes' });
    for (const [key, label] of [['image', 'Image'], ['video', 'Video']]) {
      modeRow.appendChild(h('button', {
        className: `mp-tab${this.aiMode === key ? ' active' : ''}`,
        onClick: () => { this.aiMode = key; this.render(); },
      }, label));
    }
    wrap.appendChild(modeRow);

    if (this.aiMode === 'image') this.renderAIImage(wrap);
    else this.renderAIVideo(wrap);
  }

  renderAIImage(wrap) {
    // Provider
    const providerSel = h('select', { className: 'mp-select' });
    if (this.providers.openai) providerSel.appendChild(h('option', { value: 'openai' }, 'OpenAI (GPT Image)'));
    if (this.providers.replicate) providerSel.appendChild(h('option', { value: 'replicate' }, 'Replicate (Flux)'));
    if (!this.providers.openai && !this.providers.replicate) {
      providerSel.appendChild(h('option', { value: '' }, 'No provider configured'));
    }
    wrap.appendChild(h('div', { className: 'mp-row' }, providerSel));

    // Prompt
    const prompt = h('textarea', { className: 'mp-prompt', placeholder: 'Describe the image...', rows: '3' });
    wrap.appendChild(prompt);

    // Size
    const sizeSel = h('select', { className: 'mp-select' });
    sizeSel.appendChild(h('option', { value: '1024x1024' }, '1:1 Square'));
    sizeSel.appendChild(h('option', { value: '1536x1024' }, 'Landscape'));
    sizeSel.appendChild(h('option', { value: '1024x1536' }, 'Portrait'));
    wrap.appendChild(h('div', { className: 'mp-row' }, sizeSel));

    // Generate
    const status = h('div', { className: 'mp-gen-status' });
    const genBtn = h('button', {
      className: 'mp-gen-btn',
      onClick: async () => {
        const provider = providerSel.value;
        const text = prompt.value.trim();
        if (!text || !provider) return;
        const [w, hh] = sizeSel.value.split('x').map(Number);
        genBtn.disabled = true;
        status.textContent = 'Generating image...';
        try {
          const data = await api.post('/api/media/generate/image', { prompt: text, width: w, height: hh, provider });
          status.innerHTML = '';
          const preview = h('div', { className: 'mp-gen-preview' });
          const src = data.imageBase64 ? `data:image/png;base64,${data.imageBase64}` : data.imageUrl;
          preview.appendChild(h('img', { src }));
          preview.appendChild(h('button', {
            className: 'mp-gen-use',
            onClick: () => {
              const fn = `ai-${Date.now()}.png`;
              this.downloadAndInsert(data.imageBase64 ? null : data.imageUrl, fn, 'image', data.imageBase64);
            },
          }, 'Use in project'));
          status.appendChild(preview);
        } catch (err) {
          status.textContent = `Error: ${err.message}`;
        }
        genBtn.disabled = false;
      },
    }, 'Generate Image');
    wrap.appendChild(genBtn);
    wrap.appendChild(status);

    if (!this.providers.openai && !this.providers.replicate) {
      wrap.appendChild(h('div', { className: 'mp-notice' }, 'Set OPENAI_API_KEY or REPLICATE_API_TOKEN to enable AI image generation.'));
    }
  }

  renderAIVideo(wrap) {
    // Provider
    const providerSel = h('select', { className: 'mp-select' });
    if (this.providers.replicate) providerSel.appendChild(h('option', { value: 'replicate' }, 'Replicate (Luma Ray)'));
    if (!this.providers.replicate) {
      providerSel.appendChild(h('option', { value: '' }, 'No provider configured'));
    }
    wrap.appendChild(h('div', { className: 'mp-row' }, providerSel));

    // Prompt
    const prompt = h('textarea', { className: 'mp-prompt', placeholder: 'Describe the video...', rows: '3' });
    wrap.appendChild(prompt);

    // Duration
    const durSel = h('select', { className: 'mp-select' });
    durSel.appendChild(h('option', { value: '5' }, '5 seconds'));
    durSel.appendChild(h('option', { value: '10' }, '10 seconds'));
    wrap.appendChild(h('div', { className: 'mp-row' }, durSel));

    // Generate
    const status = h('div', { className: 'mp-gen-status' });
    const genBtn = h('button', {
      className: 'mp-gen-btn',
      onClick: async () => {
        const provider = providerSel.value;
        const text = prompt.value.trim();
        if (!text || !provider) return;
        genBtn.disabled = true;
        status.textContent = 'Generating video... This may take a few minutes.';
        try {
          const data = await api.post('/api/media/generate/video', {
            prompt: text, duration: parseInt(durSel.value), provider,
          });
          status.innerHTML = '';
          const preview = h('div', { className: 'mp-gen-preview' });
          preview.appendChild(h('video', { src: data.videoUrl, controls: true, autoplay: true, loop: true, muted: true }));
          preview.appendChild(h('button', {
            className: 'mp-gen-use',
            onClick: () => this.downloadAndInsert(data.videoUrl, `ai-video-${Date.now()}.mp4`, 'video'),
          }, 'Use in project'));
          status.appendChild(preview);
        } catch (err) {
          status.textContent = `Error: ${err.message}`;
        }
        genBtn.disabled = false;
      },
    }, 'Generate Video');
    wrap.appendChild(genBtn);
    wrap.appendChild(status);

    if (!this.providers.replicate) {
      wrap.appendChild(h('div', { className: 'mp-notice' }, 'Set REPLICATE_API_TOKEN to enable AI video generation.'));
    }
  }

  // ── Upload tab ──
  renderUpload(wrap) {
    const dropzone = h('div', { className: 'mp-dropzone' });
    dropzone.innerHTML = '<div class="mp-drop-icon">+</div><div class="mp-drop-text">Drop files or click to browse</div><div class="mp-drop-hint">PNG, JPG, SVG, GIF, WebP, MP4, WebM</div>';

    const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.svg' });
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => this.handleFiles(fileInput.files));
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); this.handleFiles(e.dataTransfer.files); });

    wrap.appendChild(dropzone);
    wrap.appendChild(fileInput);
    this.uploadStatus = h('div', { className: 'mp-upload-status' });
    wrap.appendChild(this.uploadStatus);
  }

  // ── Shared helpers ──

  _renderSearchBar(wrap, placeholder, onSearch) {
    const row = h('div', { className: 'mp-search' });
    const input = h('input', { type: 'text', placeholder, value: this.query });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.query = input.value.trim(); this.page = 1; onSearch(); }
    });
    row.appendChild(input);
    row.appendChild(h('button', { className: 'mp-search-btn', onClick: () => { this.query = input.value.trim(); this.page = 1; onSearch(); } }, 'Search'));
    wrap.appendChild(row);
  }

  _renderLoadMore(wrap, onLoad) {
    this._loadMoreBtn = h('button', { className: 'mp-load-more', onClick: onLoad, style: { display: 'none' } }, 'Load more');
    wrap.appendChild(this._loadMoreBtn);
  }

  _renderProviderNotice(wrap, provider) {
    if (!this.providers[provider]) {
      wrap.appendChild(h('div', { className: 'mp-notice' },
        `Set ${provider.toUpperCase()}_API_KEY env variable. Free key at ${provider}.com/api/`
      ));
    }
  }

  renderGridLoading() {
    if (!this.grid) return;
    this.grid.innerHTML = '';
    this.grid.appendChild(h('div', { className: 'mp-loading' }, 'Searching...'));
  }

  async handleFiles(files) {
    for (const file of files) {
      this.uploadStatus.textContent = `Uploading ${file.name}...`;
      try {
        const reader = new FileReader();
        const base64 = await new Promise((resolve) => {
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(file);
        });
        const isVideo = file.type.startsWith('video/');
        const subdir = isVideo ? 'videos' : 'images';
        const data = await api.post('/api/media/download-to-project', {
          base64, projectDir: this.projectPath, filename: file.name, subdir,
        });
        this.uploadStatus.textContent = `Uploaded: ${file.name}`;
        this.onInsert(data.relativePath, isVideo ? 'video' : 'image');
      } catch (err) {
        this.uploadStatus.textContent = `Failed: ${err.message}`;
      }
    }
  }

  async downloadAndInsert(url, filename, type = 'image', base64 = null) {
    try {
      const subdir = type === 'video' ? 'videos' : 'images';
      const data = await api.post('/api/media/download-to-project', {
        url, base64, projectDir: this.projectPath, filename, subdir,
      });
      this.onInsert(data.relativePath, type);
      this.onClose();
    } catch (err) {
      console.error('Download failed:', err);
    }
  }
}
