import { Router } from 'express';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export function createMediaRouter() {
  const router = Router();

  // ── Pixabay search (images) ──
  router.get('/search/images', async (req, res) => {
    try {
      const { q, page = 1, type = 'photo', orientation = 'all', color = '', provider = 'pixabay' } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      if (provider === 'freepik') {
        return await searchFreepikImages(req, res, q, page);
      }

      const apiKey = process.env.PIXABAY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'PIXABAY_API_KEY not configured. Get a free key at pixabay.com/api/' });

      const params = new URLSearchParams({
        key: apiKey,
        q,
        page: String(page),
        per_page: '24',
        image_type: type,
        orientation: orientation !== 'all' ? orientation : '',
        safesearch: 'true',
        lang: 'en',
      });
      if (color) params.set('colors', color);

      const resp = await fetch(`https://pixabay.com/api/?${params}`);
      const data = await resp.json();

      res.json({
        total: data.totalHits || 0,
        images: (data.hits || []).map(h => ({
          id: h.id,
          preview: h.webformatURL,
          full: h.largeImageURL,
          thumb: h.previewURL,
          width: h.imageWidth,
          height: h.imageHeight,
          tags: h.tags,
          source: 'pixabay',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pixabay search (videos) ──
  router.get('/search/videos', async (req, res) => {
    try {
      const { q, page = 1, provider = 'pixabay' } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      if (provider === 'freepik') {
        return await searchFreepikVideos(req, res, q, page);
      }

      const apiKey = process.env.PIXABAY_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'PIXABAY_API_KEY not configured' });

      const params = new URLSearchParams({
        key: apiKey,
        q,
        page: String(page),
        per_page: '12',
        safesearch: 'true',
      });

      const resp = await fetch(`https://pixabay.com/api/videos/?${params}`);
      const data = await resp.json();

      res.json({
        total: data.totalHits || 0,
        videos: (data.hits || []).map(h => ({
          id: h.id,
          thumbnail: h.videos?.small?.thumbnail || '',
          url: h.videos?.medium?.url || h.videos?.small?.url || '',
          duration: h.duration,
          width: h.videos?.medium?.width || 0,
          height: h.videos?.medium?.height || 0,
          tags: h.tags,
          source: 'pixabay',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Freepik icons search ──
  router.get('/search/icons', async (req, res) => {
    try {
      const { q, page = 1 } = req.query;
      if (!q) return res.status(400).json({ error: 'q required' });

      const apiKey = process.env.FREEPIK_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'FREEPIK_API_KEY not configured' });

      const params = new URLSearchParams({
        term: q,
        page: String(page),
        per_page: '24',
      });

      const resp = await fetch(`https://api.freepik.com/v1/icons?${params}`, {
        headers: { 'x-freepik-api-key': apiKey, 'Accept': 'application/json' },
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ error: data.message || 'Freepik icons search failed' });

      res.json({
        total: data.meta?.pagination?.total || 0,
        icons: (data.data || []).map(ic => ({
          id: ic.id,
          preview: ic.thumbnails?.[0]?.url || '',
          source: 'freepik',
          downloads: ic.downloads || {},
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Image generation (OpenAI only) ──
  router.post('/generate/image', async (req, res) => {
    try {
      const { prompt, width = 1024, height = 1024 } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

      const resp = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt,
          n: 1,
          size: mapOpenAISize(width, height),
          quality: 'medium',
        }),
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || 'Generation failed' });

      let imageUrl = null;
      let imageBase64 = null;
      if (data.data?.[0]?.b64_json) {
        imageBase64 = data.data[0].b64_json;
      } else if (data.data?.[0]?.url) {
        imageUrl = data.data[0].url;
      }

      if (!imageUrl && !imageBase64) {
        return res.status(500).json({ error: 'No image generated' });
      }

      res.json({ imageUrl, imageBase64 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI Video generation (Luma AI) ──
  router.post('/generate/video', async (req, res) => {
    try {
      const { prompt, duration = 5, aspectRatio = '16:9' } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      const apiKey = process.env.LUMAAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'LUMAAI_API_KEY not configured. Get a key at lumalabs.ai' });

      // Create generation request
      const resp = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt,
          model: 'luma-ray-flash-2',
          duration: String(Math.min(duration, 10)),
          aspect_ratio: aspectRatio,
        }),
      });

      const generation = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ error: generation.detail || generation.message || 'Generation failed' });

      // Poll for result
      const result = await pollLumaAI(generation.id, apiKey);
      if (!result.assets?.video) {
        return res.status(500).json({ error: 'No video generated' });
      }

      res.json({ videoUrl: result.assets.video });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Download media to project ──
  router.post('/download-to-project', async (req, res) => {
    try {
      const { url, base64, projectDir, filename, subdir = 'images', isFramework } = req.body;
      if (!projectDir || !filename) return res.status(400).json({ error: 'projectDir and filename required' });

      // Framework projects: save to public/ (served by dev server)
      // Static projects: save to assets/
      const baseDir = isFramework ? join(projectDir, 'public', subdir) : join(projectDir, 'assets', subdir);
      await mkdir(baseDir, { recursive: true });

      const filePath = join(baseDir, filename);

      if (base64) {
        const buffer = Buffer.from(base64, 'base64');
        await writeFile(filePath, buffer);
      } else if (url) {
        const resp = await fetch(url);
        if (!resp.ok) return res.status(500).json({ error: 'Failed to download' });
        const buffer = Buffer.from(await resp.arrayBuffer());
        await writeFile(filePath, buffer);
      } else {
        return res.status(400).json({ error: 'url or base64 required' });
      }

      // Framework: path is relative to public/ root (served as /)
      const relativePath = isFramework ? `/${subdir}/${filename}` : `assets/${subdir}/${filename}`;

      res.json({
        ok: true,
        path: filePath,
        relativePath,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Check configured providers ──
  router.get('/providers', (req, res) => {
    res.json({
      pixabay: !!process.env.PIXABAY_API_KEY,
      freepik: !!process.env.FREEPIK_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      lumaai: !!process.env.LUMAAI_API_KEY,
    });
  });

  return router;
}

// ── Freepik helpers ──

async function searchFreepikImages(req, res, q, page) {
  const apiKey = process.env.FREEPIK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FREEPIK_API_KEY not configured' });

  const params = new URLSearchParams({
    term: q,
    page: String(page),
    per_page: '24',
    filters: JSON.stringify({ content_type: { photo: '1', psd: '0', vector: '1' } }),
  });

  const resp = await fetch(`https://api.freepik.com/v1/resources?${params}`, {
    headers: { 'x-freepik-api-key': apiKey, 'Accept': 'application/json' },
  });
  const data = await resp.json();
  if (!resp.ok) return res.status(resp.status).json({ error: data.message || 'Freepik search failed' });

  res.json({
    total: data.meta?.pagination?.total || 0,
    images: (data.data || []).map(r => ({
      id: r.id,
      preview: r.image?.source?.url || r.thumbnails?.[0]?.url || '',
      full: r.image?.source?.url || '',
      thumb: r.thumbnails?.[0]?.url || '',
      width: r.image?.source?.width || 0,
      height: r.image?.source?.height || 0,
      tags: '',
      source: 'freepik',
    })),
  });
}

async function searchFreepikVideos(req, res, q, page) {
  const apiKey = process.env.FREEPIK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'FREEPIK_API_KEY not configured' });

  const params = new URLSearchParams({
    term: q,
    page: String(page),
    per_page: '12',
  });

  const resp = await fetch(`https://api.freepik.com/v1/videos?${params}`, {
    headers: { 'x-freepik-api-key': apiKey, 'Accept': 'application/json' },
  });
  const data = await resp.json();
  if (!resp.ok) return res.status(resp.status).json({ error: data.message || 'Freepik videos search failed' });

  res.json({
    total: data.meta?.pagination?.total || 0,
    videos: (data.data || []).map(v => ({
      id: v.id,
      thumbnail: v.thumbnails?.[0]?.url || '',
      url: v.video?.url || '',
      duration: v.video?.duration || 0,
      width: v.video?.width || 0,
      height: v.video?.height || 0,
      tags: '',
      source: 'freepik',
    })),
  });
}

// ── General helpers ──

function mapOpenAISize(w, h) {
  if (w === h) return '1024x1024';
  if (w > h) return '1536x1024';
  return '1024x1536';
}

async function pollLumaAI(generationId, apiKey, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const resp = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await resp.json();

    if (data.state === 'completed') return data;
    if (data.state === 'failed') {
      throw new Error(data.failure_reason || 'Video generation failed');
    }

    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Video generation timed out');
}
