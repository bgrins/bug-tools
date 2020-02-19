const puppeteer = require("puppeteer");
const fs = require("fs");
const execSync = require("child_process").execSync;
const fetch = require("node-fetch");
const REVS_FOR_BUGS = new Map();
const METADATA_FOR_BUGS = new Map();
let browser;

let { rootBug, afterDate, headless, disableCache, maxDepth } = (() => {
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
      !!string.match(/(([12]\d{3})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))/)
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

    afterDate = dateFromDashedString(afterDate);
  }

  let headless = args.indexOf("--headless") != -1;
  let disableCache = args.indexOf("--disable-cache") != -1;

  let maxDepth = 1;
  let depthIndex = args.indexOf("--max-depth");
  if (depthIndex > -1) {
    maxDepth = args[depthIndex + 1];
    if (isNaN(maxDepth)) {
      throw new Error(
        "Pass a valid number with --max-depth parameter (for example: `--max-depth 2`"
      );
    }
  }
  return { rootBug, afterDate, headless, disableCache, maxDepth };
})();

// Take --after command line arg
// Take --bug command line arg
// Build up all commits and do a separate browser to load all of the raw-revs
// diffstat -> use bash or something from node?

async function fetchCommitsFor(url, depth = 0) {
  if (depth > maxDepth) {
    return;
  }
  let bugID = url.match(/id\=(\d+)/)[1];
  if (!bugID) {
    throw new Error(`Couldn't detect bug ID for ${url}`)
  }
  let messagePadding = Array(depth * 2).join(" ");
  if (REVS_FOR_BUGS.has(url)) {
    console.log(
      `${messagePadding}Skipping because this URL has already been seen: ${url}`
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
    await page.close();
    return;
  }
  const {lastCommitTime,allRevs} = await page.evaluate((afterDate) => {
    let lastCommitTime;
    let allRevs = [...document.querySelectorAll(".comment[data-tags=bugherder]")]
      .map(comment => {
        let id = comment.getAttribute("data-id");
        return document.querySelector(`.comment-text[data-comment-id="${id}"]`);
      })
      .filter(comment => {
        let includesCommits = comment.textContent.includes(
          "https://hg.mozilla.org/mozilla-central/rev/"
        );

        lastCommitTime = document.querySelector(`.comment[data-id="${comment.getAttribute("data-comment-id")}"] .change-time .rel-time`).getAttribute("title").split(" ")[0];

        return includesCommits;
      })
      .map(comment => {
        return [...comment.querySelectorAll("a")].map(a =>
          a.href.split("/").pop()
        );
      })
      .reduce((acc, val) => acc.concat(val), []); // Flatten multiple comments into one array

      return { lastCommitTime, allRevs };
  });

  if (allRevs.length && !lastCommitTime) {
    throw new Error("Got revs but no commit time");
  }
  if (!allRevs.length && lastCommitTime) {
    throw new Error("Got no revs but a commit time");
  }

  // https://bugzilla.mozilla.org/rest/bug?include_fields=id,summary,status,cf_last_resolved,assigned_to&classification=Client%20Software&classification=Developer%20Infrastructure&classification=Components&classification=Server%20Software&classification=Other&f1=blocked&o1=equals&v1=1579952
  let bugzillaMetadataRequestURL = `https://bugzilla.mozilla.org/rest/bug?include_fields=id,summary,status,assigned_to,cf_last_resolved&bug_id=${bugID}&bug_id_type=anyexact`;
  let metadataRequest = await fetch(bugzillaMetadataRequestURL);
  // let metadataRequest = await fetch(`https://bugzilla.mozilla.org/buglist.cgi?bug_id=${bugID}&bug_id_type=anyexact&classification=Client%20Software&classification=Developer%20Infrastructure&classification=Components&classification=Server%20Software&classification=Other&query_format=advanced&resolution=---&resolution=FIXED&resolution=INVALID&resolution=WONTFIX&resolution=INACTIVE&resolution=DUPLICATE&resolution=WORKSFORME&resolution=INCOMPLETE&resolution=SUPPORT&ctype=csv&human=1`);
  let metadata = await metadataRequest.json();

  if (!metadata || !metadata.bugs.length == 1) {
    throw new Error(`Unexpected data from ${bugzillaMetadataRequestURL}`);
  }
  /* This looks like:
  {
    cf_last_resolved: "2019-12-12T04:27:46Z"
    summary: 'Migrate xul test files in js/ to .xhtml',
    assigned_to_detail: [Object],
    status: 'RESOLVED',
    assigned_to: 'emalysz@mozilla.com',
    id: 1589254 }
  */
  metadata = metadata.bugs[0];

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

  let includeCommits = true;
  if (lastCommitTime) {
    if (dateFromDashedString(lastCommitTime) < afterDate) {
      console.log(`${messagePadding}Skipping ${metadata.summary} because the last commit is too old (${lastCommitTime})`);
      includeCommits = false;
    }
  }
  if (includeCommits) {
    REVS_FOR_BUGS.set(url, allRevs);
    console.log(
      `${messagePadding}There are ${resolvedBugs.length} dependancies and ${allRevs.length} mozilla-central commits for ${bugID}: ${metadata.summary} (${metadata.assigned_to} at ${metadata.cf_last_resolved})`
    );
  }

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

  console.log(`Total for ${rootBug} with depth=${maxDepth}:
${REVS_FOR_BUGS.size} bugs with ${flattenedRevs.length} total revisions.
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

// Convert "2019-10-21" to a Date object:
function dateFromDashedString(dateString) {
  let dateParts = dateString.split("-");
  return new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
}

function dashedStringFromDate(dateObj) {
  return new Date(dateObj.getTime() - dateObj.getTimezoneOffset() * 60000)
  .toISOString()
  .split("T")[0];
}
