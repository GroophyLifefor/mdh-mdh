import { defineConfig } from 'astro/config';

// /p/<id> is one page; the client reads the id from the path.
// Express does the same rewrite in production — this is for `pnpm dev`.
const projectPathRewrite = {
  name: 'project-path-rewrite',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/p\/[^/?#.]+/.test(req.url)) {
        const q = req.url.indexOf('?');
        req.url = '/p/' + (q >= 0 ? req.url.slice(q) : '');
      }
      next();
    });
  },
};

// In `pnpm dev` the API runs as a separate server. The server's CSRF check compares Origin with the request's host.
// xfwd sends X-Forwarded-Host (the page's own address); run the server with TRUST_PROXY=true so it uses it.
const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  output: 'static',
  vite: { plugins: [projectPathRewrite], server: { proxy: { '/api': { target: api, xfwd: true } } } },
});
