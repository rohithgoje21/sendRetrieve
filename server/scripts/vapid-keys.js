// Makes a key pair for browser notifications (Web Push). Put the output in
// server/.env or the environment, and keep the private key secret:
//
//   npm run vapid-keys -w server
//
// Changing keys later invalidates existing browser subscriptions (users turn
// notifications on again).

const webpush = require("web-push");

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
