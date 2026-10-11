// The web view's service worker, served as /sw.js (web.ts). It shows gaidin's notifications (push.ts), opens
// the web view when one is tapped, and answers with a short page when the server can't be reached, such as
// from a phone off the tailnet. It caches nothing; everything else goes to the network as usual.

const OFFLINE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>gaidin</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-content:center;gap:12px;padding:24px;background:oklch(15.5% 0.008 250);color:oklch(92% 0.006 250);
font:16px/1.5 Seravek,"Gill Sans Nova",Ubuntu,"Noto Sans","Open Sans",sans-serif;text-align:center}p{margin:0;color:oklch(75% 0.012 250)}
button{justify-self:center;padding:8px 16px;border:1px solid oklch(33% 0.013 250);border-radius:8px;background:oklch(22.5% 0.011 250);color:inherit;font:inherit}</style></head>
<body><strong>gaidin can't be reached</strong><p>Check that this device is on the tailnet.</p><button onclick="location.reload()">Try again</button></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let message = {};
	try {
		message = event.data?.json() ?? {};
	} catch {}
	// Every push shows a notification: browsers stop delivering to apps that don't.
	event.waitUntil(
		self.registration.showNotification(message.title ?? "gaidin", {
			body: message.body ?? "",
			tag: message.tag,
			icon: "/icon-192.png",
			data: { url: message.url ?? "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const client = open.find((c) => new URL(c.url).origin === self.location.origin);
			if (client !== undefined) await client.focus();
			else await self.clients.openWindow(url);
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
