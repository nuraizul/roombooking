#!/usr/bin/env bash
# RoomFlow one-shot deploy: GitHub push + Railway deploy + volume + domain.
# Usage:  bash deploy.sh
# Needs: git, node (20.10+), and a GitHub account. Railway CLI is installed automatically via npm.
set -e

cd "$(dirname "$0")"
echo "=== RoomFlow deploy ==="

# ---- 0. Checks
command -v git >/dev/null || { echo "Git tidak dijumpai. Pasang dari https://git-scm.com"; exit 1; }
command -v node >/dev/null || { echo "Node.js tidak dijumpai. Pasang Node 22 LTS dari https://nodejs.org"; exit 1; }
[ -f package.json ] || { echo "package.json tidak dijumpai. Jalankan skrip dalam folder roombooking."; exit 1; }

# ---- 1. Project files
if ! grep -q '"engines"' package.json; then
  node -e 'const f="package.json",p=require("./"+f);p.engines={node:">=20.10"};require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
  echo "[ok] Tambah engines ke package.json"
fi
printf 'node_modules/\ndata/\n' > .gitignore

# ---- 2. Git + GitHub
read -r -p "Username GitHub anda: " GH_USER
read -r -p "Nama repo (tekan Enter untuk 'roomflow'): " REPO
REPO=${REPO:-roomflow}

[ -d .git ] || git init -q -b main
git add -A
git commit -qm "RoomFlow deploy" 2>/dev/null || echo "[info] Tiada perubahan baru untuk commit"

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh repo view "$GH_USER/$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private --source=. --remote=origin >/dev/null
  echo "[ok] Repo GitHub sedia (via gh CLI)"
else
  echo ""
  echo "Belum ada login GitHub CLI. Buat repo kosong di https://github.com/new dengan nama '$REPO'"
  echo "(jangan tick README / .gitignore / license), kemudian tekan Enter."
  read -r _
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$GH_USER/$REPO.git"
fi
git push -u origin main
echo "[ok] Kod dah ditolak ke GitHub"

# ---- 3. Railway
if ! command -v railway >/dev/null; then
  echo "Pasang Railway CLI..."
  npm install -g @railway/cli >/dev/null 2>&1
fi
railway whoami >/dev/null 2>&1 || { echo "Login Railway (browser akan dibuka)..."; railway login; }

echo "Cipta / sambung projek Railway..."
railway init --name "$REPO" >/dev/null 2>&1 || true
railway link >/dev/null 2>&1 || true

echo "Deploy (build mungkin ambil 1-3 minit)..."
railway up --detach

# ---- 4. Volume untuk database (sekali sahaja)
railway volume add --mount-path /app/data >/dev/null 2>&1 && echo "[ok] Volume /app/data ditambah" \
  || echo "[info] Volume tidak ditambah automatik (mungkin dah wujud). Semak di dashboard Railway > Volumes."

# ---- 5. Domain
URL=$(railway domain 2>/dev/null | grep -Eo 'https://[^ ]+' | head -1 || true)
if [ -z "$URL" ]; then
  URL=$(railway domain 2>/dev/null | grep -Eo '[a-zA-Z0-9.-]+\.up\.railway\.app' | head -1 || true)
  [ -n "$URL" ] && URL="https://$URL"
fi

echo ""
echo "=== SELESAI ==="
echo "Dashboard : ${URL:-semak di railway.app > projek anda > Settings > Networking}"
echo "Tablet    : ${URL:-https://URL-ANDA}/display.html?code=DISPLAY-101"
echo "Log       : railway logs"
