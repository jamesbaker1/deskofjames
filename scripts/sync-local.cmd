@echo off
rem Daily local substack sync. Runs from a desk instead of a datacenter because
rem Substack's CDN turns away GitHub's runner IPs; a residential connection walks
rem right in. Scheduled via Windows Task Scheduler ("deskofjim substack sync").
cd /d "%~dp0.."
git pull --rebase --quiet origin master || exit /b 1
node scripts\fetch-substack.mjs || exit /b 1
rem New essay pages arrive as untracked directories, so stage before testing. The quotes keep
rem cmd's hands off the wildcard: git expands the pathspec, and only over what the generator
rem writes — posts.json and the contents of the per-post directories.
git add -- blog/posts.json "blog/*/*" || exit /b 1
git diff --cached --quiet -- blog && exit /b 0
git commit -q -m "sync substack posts"
git push -q origin master
