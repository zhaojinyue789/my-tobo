// 应用外壳缓存：dist 是单文件 index.html，缓存导航入口即可离线使用；
// 网络优先保证更新能到达，断网时回退缓存。
const CACHE_NAME = "my-tobo-v1";
const SHELL_ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // 只处理同源 GET；GitHub API 同步请求不经过 SW
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // 导航请求：先网络拿最新单文件，失败回退缓存（离线可用）
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((hit) => hit ?? caches.match("./"))),
    );
    return;
  }

  // 其余静态资源（图标等）：缓存优先，未命中走网络并写入缓存
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        }),
    ),
  );
});
