@echo off
rem Daily local substack sync. Runs from a desk instead of a datacenter because
rem Substack's CDN turns away GitHub's runner IPs; a residential connection walks
rem right in. Scheduled via Windows Task Scheduler ("deskofjim substack sync").
cd /d "%~dp0.."
git pull --rebase --quiet origin master || exit /b 1
node scripts\fetch-substack.mjs || exit /b 1
git diff --quiet -- blog/posts.json && exit /b 0
git add blog/posts.json
git commit -q -m "sync substack posts"
git push -q origin master
