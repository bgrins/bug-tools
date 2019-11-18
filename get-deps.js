const puppeteer = require("puppeteer");
const fs = require("fs");
const execSync = require("child_process").execSync;
const fetch = require("node-fetch");
const MAX_DEPTH = 1;
const MAX_DAYS_SINCE_COMMIT = 1;
const COMMITS_FOR_BUGS = new Map();
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
  if (COMMITS_FOR_BUGS.has(url)) {
    console.log("Already seen", url);
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
    console.log("Skipping meta");
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
        return [...comment.querySelectorAll("a")].map(a => a.href);
      });
  });

  COMMITS_FOR_BUGS.set(url, commits);

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
    `Completed ${url}: ${resolvedBugs.length} dependancies and ${commits.length} mozilla-central commits`
  );
  await page.close();

  for (let bug of resolvedBugs) {
    await fetchCommitsFor(bug.url, depth + 1);
  }
}
(async () => {
  browser = await puppeteer.launch({ headless });
  await fetchCommitsFor(rootBug);
  console.log(COMMITS_FOR_BUGS, METADATA_FOR_BUGS);
  await browser.close();

  console.log("Fetching raw rev");

  let revString = "b8a5f2a349bc";
  let fileName = `cache/${revString}.diff`;
  if (disableCache || !fs.existsSync(fileName)) {
    downloadFile(
      `https://hg.mozilla.org/mozilla-central/raw-rev/${revString}`,
      fileName
    );
  }

  console.log(parseDiffstatOutput(execSync(`diffstat ${fileName}`).toString()));
})();

function parseDiffstatOutput(str) {
  /* The output looks like:
  `
  base/Element.cpp     |   24 +++---------------------
  base/nsIContent.h    |    4 ++--
  xul/nsXULElement.cpp |   14 ++------------
  xul/nsXULElement.h   |   15 ---------------
  4 files changed, 7 insertions(+), 50 deletions(-)
  `
  */

  let matches = str.match(
    /(\d+) files changed, (\d+) insertions\(\+\), (\d+) deletions\(\-\)/
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
