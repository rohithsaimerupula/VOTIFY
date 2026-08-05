/**
 * build-www.js
 * Copies all web-facing assets into the `www/` folder for Capacitor.
 * Run with: node build-www.js
 */

const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const DEST = path.join(__dirname, 'www');

// Files and folders to include in the Android app
const INCLUDE = [
    'index.html',
    'login.html',
    'register.html',
    'admin_dashboard.html',
    'subadmin_dashboard.html',
    'superadmin_dashboard.html',
    'voter_dashboard.html',
    'profile_portal.html',
    'developer.html',
    'style.css',
    'storage.js',
    'session-guard.js',
    'service-worker.js',
    'manifest.json',
    'assets',
];

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach(child => {
            copyRecursive(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

// Clean and recreate www/
if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
    console.log('🗑  Cleaned old www/');
}
fs.mkdirSync(DEST, { recursive: true });

// Copy each asset
INCLUDE.forEach(name => {
    const srcPath = path.join(SRC, name);
    const destPath = path.join(DEST, name);
    if (fs.existsSync(srcPath)) {
        copyRecursive(srcPath, destPath);
        console.log(`✅ Copied: ${name}`);
    } else {
        console.warn(`⚠️  Not found, skipping: ${name}`);
    }
});

console.log('\n🎉 www/ folder ready for Capacitor!\n');
