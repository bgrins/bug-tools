const puppeteer = require("puppeteer");
const fs = require("fs");
const execSync = require("child_process").execSync;
const fetch = require("node-fetch");
const MAX_DEPTH = 1;
const REVS_FOR_BUGS = new Map();
const METADATA_FOR_BUGS = new Map();
let browser;

let { rootBug, afterDate, headless, disableCache } = (() => {
  const isValidUrl = string => {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  };
  const isValidDate = string => {
    return (
      string &&
      !!string.match(/([12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/)
    );
  };

  let args = process.argv.slice(2);
  let rootBug = null;
  let bugIndex = args.indexOf("--bug");
  if (bugIndex > -1) {
    rootBug = args[bugIndex + 1];
  }

  if (!isValidUrl(rootBug)) {
    throw new Error(
      "Pass a bug URL with the --bug parameter (for example: `--bug https://bugzilla.mozilla.org/show_bug.cgi?id=1566221"
    );
  }

  let afterDate = null;
  let afterIndex = args.indexOf("--after");
  if (afterIndex > -1) {
    afterDate = args[afterIndex + 1];
    if (!isValidDate(afterDate)) {
      throw new Error(
        "Pass a valid date with --after parameter (for example: `--after 2019-11-10`"
      );
    }
  }

  let headless = args.indexOf("--headless") != -1;
  let disableCache = args.indexOf("--disable-cache") != -1;
  return { rootBug, afterDate, headless, disableCache };
})();

// Take --after command line arg
// Take --bug command line arg
// Build up all commits and do a separate browser to load all of the raw-revs
// diffstat -> use bash or something from node?

async function fetchCommitsFor(url, depth = 0) {
  if (depth > MAX_DEPTH) {
    return;
  }
  let messagePadding = Array(depth * 2).join(" ");
  if (REVS_FOR_BUGS.has(url)) {
    console.log(
      `${messagePadding}Skipping because this URL has already been seen (I don't think this should happen): ${url}`
    );
    return;
  }

  const page = await browser.newPage();
  await page.goto(url);

  const skip = await page.evaluate(() => {
    let meta = document.querySelector(
      `#field-value-keywords a[href="/buglist.cgi?keywords=meta&resolution=---"]`
    );
    return !!meta;
  });

  if (depth > 0 && skip) {
    console.log(`${messagePadding}Skipping metabug: ${url}`);
    return;
  }
  const commits = await page.evaluate(() => {
    return [...document.querySelectorAll(".comment[data-tags=bugherder]")]
      .map(comment => {
        let id = comment.getAttribute("data-id");
        return document.querySelector(`.comment-text[data-comment-id="${id}"]`);
      })
      .filter(comment => {
        return comment.textContent.includes(
          "https://hg.mozilla.org/mozilla-central/rev/"
        );
      })
      .map(comment => {
        return [...comment.querySelectorAll("a")].map(a =>
          a.href.split("/").pop()
        );
      })
      .reduce((acc, val) => acc.concat(val), []); // Flatten multiple comments into one array
  });

  REVS_FOR_BUGS.set(url, commits);

  const metadata = await page.evaluate(() => {
    let email = document.querySelector("#field-value-assigned_to .email");
    return {
      title: document.title,
      assignee: email && email.getAttribute("data-user-email")
    };
  });
  METADATA_FOR_BUGS.set(url, metadata);

  const resolvedBugs = await page.evaluate(() => {
    return [
      ...document.querySelectorAll(
        "#field-value-dependson .bz_bug_link.bz_status_RESOLVED.bz_closed"
      )
    ].map(link => {
      return {
        title: link.getAttribute("title"),
        url: link.href
      };
    });
  });
  console.log(
    `${messagePadding}For ${url} there are ${resolvedBugs.length} dependancies and ${commits.length} mozilla-central commits`
  );
  await page.close();

  for (let bug of resolvedBugs) {
    await fetchCommitsFor(bug.url, depth + 1);
  }
}
(async () => {
  browser = await puppeteer.launch({ headless });
  await fetchCommitsFor(rootBug);
  console.log(REVS_FOR_BUGS, METADATA_FOR_BUGS);
  await browser.close();

  let totalChanged = (totalInsertions = totalDeletions = 0);
  let flattenedRevs = [];
  for (let revs of REVS_FOR_BUGS.values()) {
    for (let rev of revs) {
      flattenedRevs.push(rev);
    }
  }
  for (let rev of flattenedRevs) {
    let fileName = `cache/${rev}.diff`;
    if (disableCache || !fs.existsSync(fileName)) {
      console.log(`Fetching ${rev}`);
      await downloadFile(
        `https://hg.mozilla.org/mozilla-central/raw-rev/${rev}`,
        fileName
      );
    }

    console.log(`Executing: |diffstat -t ${fileName}|`);

    let { changed, insertions, deletions } = parseDiffstatOutput(
      execSync(`diffstat -t ${fileName}`).toString()
    );
    console.log(
      `For ${fileName} we have ${changed} changed, ${insertions} insertions, ${deletions} deletions`
    );
    totalChanged += changed;
    totalInsertions += insertions;
    totalDeletions += deletions;
  }

  console.log(`Total for ${rootBug} with depth=${MAX_DEPTH}:
${totalChanged} changed, ${totalInsertions} insertions, ${totalDeletions} deletions.
Net addition of ${totalInsertions - totalDeletions} lines.`);
})();

function parseDiffstatOutput(str) {
/*
The output looks something like this, with an extra newline at the end

`
INSERTED,DELETED,MODIFIED,FILENAME
0,4,0,GeckoBindings.cpp
0,4,0,GeckoBindings.h
`
*/

  let rows = str.split("\n");
  if (rows[0] != "INSERTED,DELETED,MODIFIED,FILENAME" || rows[rows.length - 1] != "") {
    throw new Error(`Unexpected |diffstat -t| output ${str}`);
  }

  let insertions = 0;
  let deletions = 0;
  let changed = 0;
  for (let row of rows.slice(1, -1)) {
    let cols = row.split(",");
    insertions += parseInt(cols[0]);
    deletions += parseInt(cols[1]);
    changed += parseInt(cols[2]);
  }
  return { insertions, deletions, changed };
}

function parseDiffstatOutputOld(str) {
  /* The output looks like:
  `
base/Element.cpp     |   24 +++---------------------
base/nsIContent.h    |    4 ++--
xul/nsXULElement.cpp |   14 ++------------
xul/nsXULElement.h   |   15 ---------------
4 files changed, 7 insertions(+), 50 deletions(-)
  `

  or:

  `
 dom/base/Document.cpp                            |   12 ------------
 dom/base/Document.h                              |    7 -------
 dom/webidl/Document.webidl                       |    3 ---
 js/xpconnect/tests/mochitest/test_bug912322.html |    3 +--
 4 files changed, 1 insertion(+), 24 deletions(-)
  `
  */

  let matches = str.match(
    /(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(\-\)/
  );

  if (!matches) {
    throw new Error("Couldn't detect diffstat output");
  }

  return {
    changed: matches[1],
    insertions: matches[2],
    deletions: matches[3]
  };
}

const downloadFile = async (url, path) => {
  const res = await fetch(url);
  const fileStream = fs.createWriteStream(path);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", err => {
      reject(err);
    });
    fileStream.on("finish", function() {
      resolve();
    });
  });
};
