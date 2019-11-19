Example usage:

```
node get-deps.js --bug https://bugzilla.mozilla.org/show_bug.cgi?id=1596199 --after 2019-11-10 --headless --disable-cache
```

```
node get-deps.js --bug https://bugzilla.mozilla.org/show_bug.cgi?id=1566221 --after 2019-10-28 --headless --max-depth 2
```

As of 2019-11-18 returns:

```
Total for https://bugzilla.mozilla.org/show_bug.cgi?id=1566221 with depth=2:
40 bugs with 82 total revisions.
0 changed, 725 insertions, 23801 deletions.
Net addition of -23076 lines.
```
