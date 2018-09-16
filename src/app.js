#! /usr/bin/env node
const program = require('commander')
const pkg = require('../package.json')
const chalk = require('chalk')
const requestPromise = require('request-promise')
const request = require('request')
const PleasantProgress = require('pleasant-progress')
const path = require('path')
const fs = require('fs')
const inquirer = require('inquirer')
const puppeteer = require('puppeteer')

let urlValue
let outputDir
let isPro = false
const prompt = inquirer.createPromptModule()
const progress = new PleasantProgress()
const rp = requestPromise.defaults({jar: true})
const SIGN_IN_URL = 'https://egghead.io/users/sign_in'

program
  .version(pkg.version)
  .arguments('<url> [output-dir]')
  .option('-e, --email <email>', 'Account email (only required for Pro accounts)')
  .option('-p, --password [password]', 'Account password (only required for Pro accounts)', true)
  .option('-c, --count', 'Add the number of the video to the filename (only for playlists and series)')
  .option('-f, --force', 'Overwriting existing files')
  .action((url, output) => {
    urlValue = url
    outputDir = output ? path.resolve(output) : null
  })
program.parse(process.argv)

if (process.argv.slice(2).length < 2) {
  program.outputHelp()
  process.exit()
}

if (!/egghead.io\/(lessons|series|playlists|courses)\//.test(urlValue)) {
  error('unsupported url!')
}

// await is only supported in functions (with the async keyword)
doTheMagic()

function fileExists (p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    return false
  }
}

async function getCSRFToken () {
  const body = await rp(SIGN_IN_URL)
  const pattern = /<meta name="csrf-token" content="(.*)" \/>/
  const [, CSRFToken] = pattern.exec(body) || []
  return CSRFToken
}

async function authenticate (email, password) {
  const CSRFToken = await getCSRFToken()
  const options = {
    method: 'POST',
    uri: SIGN_IN_URL,
    form: {
      'user[email]': email,
      'user[password]': password,
      'authenticity_token': CSRFToken
    },
    simple: false,
    resolveWithFullResponse: true
  }

  const response = await rp(options)

  if (response.statusCode !== 302) {
    throw Error('Failed to authenticate.')
  }
}

async function doTheMagic () {
  if (program.email) {
    if (program.password === true) {
      const { password } = await prompt({
        type: 'password',
        name: 'password',
        message: 'Egghead.io password'
      })
      program.password = password
    }
    try {
      await authenticate(program.email, program.password)
      isPro = true
      success('Authenticated!')
    } catch (err) {
      return error(err)
    }
  }

  const {lessonSlug, lessonData: videos} = await getVideoData()
  if (!videos.length) {
    error('no video found!')
  }
  success(`Found ${videos.length} ${(videos.length) > 1 ? 'videos' : 'video'}`)

  if (!outputDir) {
    outputDir = path.resolve(lessonSlug)
  }
  createOutputDirectoryIfNeeded()

  const padLength = String(videos.length).length
  const padZeros = '0'.repeat(padLength)
  let i = 0
  for (const {url, filename, code} of videos) {
    i++
    let paddedCounter = `${padZeros}${i}`.slice(-padLength)
    const p = path.join(outputDir, (program.count ? `${paddedCounter}-${filename}.mp4` : `${filename}.mp4`))
    if (!program.force && fileExists(p)) {
      console.log(`File ${paddedCounter}-${filename} already exists, skip`)
      continue
    }
    progress.start(`Downloading video ${paddedCounter} out of ${videos.length}: '${filename}'`)
    const stream = fs.createWriteStream(p)
    let downloadURL = await rp(url)
    await new Promise((resolve, reject) => {
      request(downloadURL)
        .on('error', () => {
          let msg = `download of '${downloadURL}' failed!`
          error(msg, false)
          reject(new Error(msg))
        })
        .on('end', () => {
          resolve()
        })
        .pipe(stream)
    })
    stream.close()
    progress.stop(true)

    if (code) {
      Object.keys(code).forEach(service => {
        fs.appendFile(path.join(outputDir, `${service}.txt`), `https://github.com/${code[service].user}/${code[service].repo}/tree/${code[service].branch}\n`, err => {
          if (err) throw err
        })
      })
    }
  }
  success('Done!')
}

async function getLessionURLs (url) {
  return (async () => {
    const browser = await puppeteer.launch({ headless: true })
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 926 })
    await page.goto(url)
    let data = await page.evaluate(() => Array.from(document.querySelectorAll('.index__hoverListItem__5b00de116ebc92ec28e53feb410bf6a5')).map(link => link.href))
    await page.close()
    await browser.close()
    return data
  })()
}

// loads the url and parses it, when it's playlist/series loads the video pages
// too, and returns an array with the video data
async function getVideoData () {
  try {
    const [, lessonSlug] = /egghead.io\/lessons\/([^?]*)/.exec(urlValue) || []
    let source = await rp(urlValue)

    if (lessonSlug) {
      let videoData
      success('The URL is a lesson')

      if (isPro) {
        const response = await rp({
          uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
          json: true
        })
        const { lessons } = response.list || {lessons: []}

        videoData = lessons
          .filter((lesson) => lesson.slug === lessonSlug)
          .map((lesson) => {
            const pattern = /https:\/\/.*\/lessons\/.*\/(.*)\?.*/
            const [url, filename] = pattern.exec(lesson.download_url)
            return {url, filename}
          })[0]
      } else {
        videoData = parseLessonPage(source)
      }

      // process the lesson page
      if (videoData) {
        return [videoData]
      } else {
        error(`failed to parse the lesson page '${urlValue}'}`)
      }
    } else {
      let lessonURLs = await getLessionURLs(urlValue)
      if (isPro) {
        const firstLesson = lessonURLs[0]
        const pattern = /egghead.io\/lessons\/(.*)/
        const [, lessonSlug] = pattern.exec(firstLesson) || []
        const response = await rp({
          uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
          json: true
        })
        const { lessons } = response.list || {lessons: []}
        const lessonData = lessons.map(lesson => ({url: lesson.download_url, filename: lesson.slug, code: lesson.code}))
        return {lessonSlug, lessonData}
      }

      progress.start('Fetching lesson pages')
      // fetch and process the lessons, start all requests at the same time to save time.
      const promises = lessonURLs.map(processLessonURL)
      const result = await Promise.all(promises.map(reflect))
      progress.stop(true)
      // get the urls that succeeded and those that failed
      const videoURLs = result.filter(v => (v.state === 'resolved')).map(v => v.value)
      const failed = result.filter(v => (v.state === 'rejected'))
      // check if we have some lesson pages that failed (wrong url or paid)
      if (failed.length) {
        error(`Failed to parse the following lesson pages: ${failed.map(v => `'${v.value}'`).join(',')}. They might be for pro subscribers only`, false)
      }
      return videoURLs
    }
  } catch (e) {
    error(`fetching the url '${urlValue}' failed!`)
  }
}

// fetches the lesson page and calls parseLessonPage on it
function processLessonURL (url) {
  return new Promise(async (resolve, reject) => {
    rp(url).then((source) => {
      const videoData = parseLessonPage(source)
      if (videoData) {
        resolve(videoData)
      } else {
        reject(url)
      }
    }, () => {
      reject(url)
    })
  })
}

// parses the lesson page, returns the video data if found.
function parseLessonPage (source) {
  const re = /<meta itemprop="name" content="([^"]+?)".+?<meta itemprop="contentURL" content="http[^"]+?.wistia.com\/deliveries\/(.+?)\.bin"/
  const result = re.exec(source)
  if (result) {
    return {
      filename: result[1],
      url: `https://embed-ssl.wistia.com/deliveries/${result[2]}/file.mp4`
    }
  }
}

// creates a directory
function createOutputDirectoryIfNeeded () {
  try {
    const stats = fs.lstatSync(outputDir)
    if (!stats.isDirectory()) {
      error(`Can't create the output directory '${outputDir}' because a file with the same name exists`)
    }
  } catch (e) {
    try {
      fs.mkdirSync(outputDir)
    } catch (err) {
      error(`Creating the output directory '${outputDir}' failed with error '${err}'`)
    }
  }
}

// helper functions
function success (message) {
  console.log(chalk.green(message))
}

function error (message, exit = true) {
  console.log(chalk.red(`Error: ${message}`))
  if (exit) {
    process.exit(1)
  }
}

// wraps a promise in another promise that resolves when the promise either resolves or rejects
function reflect (promise) {
  return promise.then(x => ({state: 'resolved', value: x}),
    e => ({state: 'rejected', value: e}))
}
