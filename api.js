var error = require('debug')('mapeo-server:error')
var fs = require('fs')
var sync = require('mapeo-sync')
var path = require('path')
var body = require('body/json')
var randombytes = require('randombytes')
var asar = require('asar')
var ecstatic = require('ecstatic')
var xtend = require('xtend')

var errors = require('./errors')

var CURRENT_SCHEMA = 3

module.exports = Api

function Api (osm, media, opts) {
  if (!(this instanceof Api)) return new Api(osm, media, opts)
  if (!opts) opts = {}
  this.osm = osm
  this.media = media
  var defaultOpts = {
    id: 'MapeoDesktop_' + randombytes(8).toString('hex'),
    staticRoot: '.'
  }
  this.opts = Object.assign(defaultOpts, opts)
  this.staticRoot = this.opts.staticRoot
  this.sync = sync(osm, media, this.opts)
}

function handleError (res, err) {
  if (typeof err === 'string') err = new Error(err)
  if (!err.status) err = errors(err)
  errors.send(res, err)
  error(err)
}

// Observations
Api.prototype.observationDelete = function (req, res, m) {
  var self = this
  res.setHeader('content-type', 'application/json')
  self.osm.del(m.id, function (err) {
    if (err) return handleError(res, err)
    res.end(JSON.stringify({deleted: true}))
  })
}

Api.prototype.observationList = function (req, res, m) {
  var results = []

  this.osm.kv.createReadStream()
    .on('data', function (row) {
      Object.keys(row.values).forEach(function (version) {
        var obs = row.values[version].value
        if (!obs) return
        if (obs.type !== 'observation') return
        obs.id = row.key
        obs.version = version
        results.push(obs)
      })
    })
    .once('end', function () {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(results.map(transformOldObservation)))
    })
    .once('error', function (err) {
      return handleError(res, errors(err))
    })
}

Api.prototype.observationGet = function (req, res, m) {
  this.osm.get(m.id, function (err, obses) {
    if (err) return handleError(res, err)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(flatObs(m.id, obses).map(transformOldObservation)))
  })
}

Api.prototype.observationCreate = function (req, res, m) {
  var self = this

  body(req, function (err, obs) {
    if (err) return handleError(res, errors.JSONParseError())
    try {
      validateObservation(obs)
    } catch (err) {
      return handleError(res, errors.InvalidFields(err.message))
    }
    const newObs = whitelistProps(obs)
    newObs.type = 'observation'
    newObs.schemaVersion = obs.schemaVersion || CURRENT_SCHEMA
    newObs.timestamp = (new Date()).toISOString()
    newObs.created_at = (new Date()).toISOString()

    self.osm.create(newObs, function (err, _, node) {
      if (err) return handleError(res, err)
      res.setHeader('content-type', 'application/json')
      newObs.id = node.value.k
      newObs.version = node.key
      res.end(JSON.stringify(newObs))
    })
  })
}

Api.prototype.observationUpdate = function (req, res, m) {
  var self = this

  body(req, function (err, newObs) {
    if (err) return handleError(res, errors.JSONParseError())

    if (typeof newObs.version !== 'string') {
      var error = new Error('the given observation must have a "version" set')
      return handleError(res, error)
    }

    if (newObs.id !== m.id) return handleError(res, errors.TypeMismatch(newObs.id, m.id))

    try {
      validateObservation(newObs)
    } catch (err) {
      return handleError(res, errors.InvalidFields(err.message))
    }

    self.osm.getByVersion(newObs.version, function (err, obs) {
      if (err && !err.notFound) return handleError(res, err)
      if (err && err.notFound) return handleError(res, errors.NoVersion())
      if (obs.id !== m.id) return handleError(res, errors.TypeMismatch(obs.id, m.id))

      var opts = {
        links: [newObs.version]
      }

      var finalObs = whitelistProps(newObs)
      finalObs.type = 'observation'
      finalObs.timestamp = new Date().toISOString()
      finalObs = Object.assign(obs, finalObs)

      self.osm.put(m.id, finalObs, opts, function (err, node) {
        if (err) return handleError(res, err)
        res.setHeader('content-type', 'application/json')
        finalObs.id = node.value.k
        finalObs.version = node.key
        res.end(JSON.stringify(finalObs))
      })
    })
  })
}

Api.prototype.observationConvert = function (req, res, m) {
  var self = this

  res.setHeader('content-type', 'application/json')

  // 1. get the observation
  this.osm.get(m.id, function (err, obses) {
    if (err) return handleError(res, err)
    if (!Object.keys(obses).length) {
      return handleError(res, 'failed to lookup observation: not found')
    }

    // 2. see if tags.element_id already present (short circuit)
    var obs = obses[Object.keys(obses)[0]]
    if (obs.tags && obs.tags.element_id) {
      res.end(JSON.stringify({ id: obs.tags.element_id }))
      return
    }

    var batch = []

    // 3. create node
    batch.push({
      type: 'put',
      key: randombytes(8).toString('hex'),
      value: xtend(obs, {
        type: 'node'
      })
    })

    // 4. modify observation tags
    obs.tags = obs.tags || {}
    obs.tags.element_id = batch[0].key
    batch.push({
      type: 'put',
      key: m.id,
      value: obs
    })

    // 5. batch modification
    self.osm.batch(batch, function (err) {
      if (err) return handleError(res, err)
      res.end(JSON.stringify({ id: obs.tags.element_id }))
    })
  })
}

// Presets
Api.prototype.presetsList = function (req, res, m) {
  var self = this
  res.setHeader('content-type', 'application/json')
  fs.readdir(path.join(self.staticRoot, 'presets'), function (err, files) {
    if (err) return handleError(res, err)
    files = files
      .filter(function (filename) {
        return fs.statSync(path.join(self.staticRoot, 'presets', filename)).isDirectory()
      })
    res.end(JSON.stringify(files))
  })
}

Api.prototype.presetsGet = function (req, res, m) {
  ecstatic({
    root: this.staticRoot,
    handleError: false
  })(req, res)
}

// Media
Api.prototype.mediaGet = function (req, res, m) {
  var self = this
  var id = m.type + '/' + m.id

  this.media.exists(id, function (err, exists) {
    if (err) return handleError(res, err)
    if (!exists) return handleError(res, errors.NotFound())
    if (m.id.endsWith('.jpg')) res.setHeader('content-type', 'image/jpeg')
    else if (m.id.endsWith('.png')) res.setHeader('content-type', 'image/png')
    self.media.createReadStream(id).pipe(res)
  })
}

Api.prototype.mediaPut = function (req, res, m, q) {
  if (!q.file || !fs.existsSync(q.file)) {
    res.statusCode = 400
    res.end()
    return
  }
  if (q.thumbnail && !fs.existsSync(q.thumbnail)) {
    res.statusCode = 400
    res.end()
    return
  }

  var self = this

  var ext = path.extname(q.file)
  var id = randombytes(16).toString('hex') + ext
  res.setHeader('content-type', 'application/json')

  var mediaPath = 'original/' + id
  var thumbnailPath = 'thumbnail/' + id

  function copyFileTo (file, to, cb) {
    var ws = self.media.createWriteStream(to, cb)
    fs.createReadStream(file).pipe(ws)
  }

  var pending = 1
  if (q.thumbnail) pending++

  // Copy original media
  copyFileTo(q.file, mediaPath, function (err) {
    if (err) return handleError(res, err)
    if (!--pending) done()
  })

  // Copy thumbnail
  if (q.thumbnail) {
    copyFileTo(q.thumbnail, thumbnailPath, function (err) {
      if (err) return handleError(res, err)
      if (!--pending) done()
    })
  }

  function done () {
    if (pending) return
    res.end(JSON.stringify({id: id}))
  }
}

// Tiles
Api.prototype.stylesList = function (req, res, m) {
  var self = this
  res.setHeader('content-type', 'application/json')
  fs.readdir(path.join(self.staticRoot, 'styles'), function (err, files) {
    if (err) return handleError(res, err)
    files = files
      .filter(function (file) {
        var stat = fs.statSync(path.join(self.staticRoot, 'styles', file))
        return stat.isDirectory() && fs.existsSync(path.join(self.staticRoot, 'styles', file, 'style.json'))
      })
      .map(function (dir) {
        var str = fs.readFileSync(path.join(self.staticRoot, 'styles', dir, 'style.json'), 'utf-8')
        if (str) {
          try {
            var json = JSON.parse(str)
            var srcTop = Object.keys(json.sources)[0] || {}
            var src = json.sources[srcTop]
            if (!src) return null
            return {
              id: dir,
              name: json.name,
              description: json.description,
              bounds: src.bounds,
              minzoom: src.minzoom,
              maxzoom: src.maxzoom
            }
          } catch (e) {
            return null
          }
        } else {
          return null
        }
      })
      .filter(Boolean)
    res.end(JSON.stringify(files))
  })
}

Api.prototype.stylesGetStyle = function (req, res, m) {
  serveStyleFile(path.join(this.staticRoot, 'styles', m.id, 'style.json'), m.id, req, res)
}

Api.prototype.stylesGetStatic = function (req, res, m) {
  ecstatic({
    root: this.staticRoot,
    handleError: false
  })(req, res)
}

Api.prototype.stylesGet = function (req, res, m) {
  var self = this
  var asarPath = path.join(self.staticRoot, 'styles', m.id, 'tiles', m.tileid + '.asar')

  var filename = [m.z, m.y, m.x].join('/') + '.' + m.ext
  var buf = asarGet(asarPath, filename)

  if (buf) {
    var mime
    switch (m.ext) {
      case 'png': mime = 'image/png'; break
      case 'jpg': mime = 'image/jpg'; break
    }
    if (mime) res.setHeader('content-type', mime)

    // Set gzip encoding on {mvt,pbf} tiles.
    if (/mvt|pbf$/.test(m.ext)) res.setHeader('content-encoding', 'gzip')

    res.end(buf)
  } else {
    return handleError(res, errors.NotFound())
  }
}

Api.prototype.syncClose = function (req, res, m) {
  this.sync.unannounce(function () {
    res.end()
  })
}

Api.prototype.syncAnnounce = function (req, res, m) {
  this.sync.announce(function () {
    res.end()
  })
}

Api.prototype.getSyncTargets = function (req, res, m) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(this.sync.targets()))
}

Api.prototype.syncToTarget = function (req, res, m, params) {
  var self = this
  var progress
  if (params.filename) {
    progress = self.sync.replicateFromFile(params.filename, self.opts)
  } else if (params.host && params.port) {
    progress = self.sync.syncToTarget(params, self.opts)
  } else return onerror(res, 'Requires filename or host and port')

  function onprogress (data) {
    if (data === 'replication-started') send(res, 'replication-started')
    else send(res, 'replication-progress', data)
  }
  progress.on('progress', onprogress)
  progress.on('error', onend)
  progress.on('end', onend)

  function onend (err) {
    if (err) return onerror(res, err.message)
    send(res, 'replication-complete')
    progress.removeListener('progress', onprogress)
    res.end()
  }

  function onerror (res, err) {
    res.statusCode = 500
    var str = JSON.stringify({topic: 'replication-error', message: err.message || err}) + '\n'
    res.end(str)
  }
}

Api.prototype.close = function (cb) {
  this.sync.close(cb)
}

function send (res, topic, msg) {
  var str = JSON.stringify({ topic: topic, message: msg }) + '\n'
  res.write(str)
}

function asarGet (archive, fn) {
  try {
    return asar.extractFile(archive, fn)
  } catch (e) {
    return undefined
  }
}

function serveStyleFile (styleFile, id, req, res) {
  fs.stat(styleFile, function (err, stat) {
    if (err) {
      res.statusCode = 500
      res.end(err.toString())
      return
    }
    fs.readFile(styleFile, 'utf8', function (err, data) {
      if (err) {
        res.statusCode = 500
        res.end(err.toString())
        return
      }
      data = Buffer.from(data.replace(/\{host\}/gm, 'http://' + req.headers.host + '/styles/' + id))
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('last-modified', (new Date(stat.mtime)).toUTCString())
      res.setHeader('content-length', data.length)
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.statusCode = 200
      res.end(data)
    })
  })
}

function flatObs (id, obses) {
  return Object.keys(obses).map(function (version) {
    var obs = obses[version]
    obs.id = id
    obs.version = version
    return obs
  })
}

function validateObservation (obs) {
  if (!obs) throw new Error('Observation is undefined')
  if (obs.type !== 'observation') throw new Error('Observation must be of type `observation`')
  if (obs.attachments) {
    if (!Array.isArray(obs.attachments)) throw new Error('Observation attachments must be an array')
    obs.attachments.forEach(function (att, i) {
      if (!att) throw new Error('Attachment at index `' + i + '` is undefined')
      if (typeof att.id !== 'string') throw new Error('Attachment must have a string id property (at index `' + i + '`)')
    })
  }
  if (typeof obs.lat !== 'undefined' || typeof obs.lon !== 'undefined') {
    if (typeof obs.lat === 'undefined' || typeof obs.lon === 'undefined') {
      throw new Error('one of lat and lon are undefined')
    }
    if (typeof obs.lat !== 'number' || typeof obs.lon !== 'number') {
      throw new Error('lon and lat must be a number')
    }
  }
}

// Top-level props that can be modified by the user/client
var USER_UPDATABLE_PROPS = [
  'lon',
  'lat',
  'attachments',
  'tags',
  'ref',
  'metadata',
  'fields',
  'schemaVersion'
]

// Filter whitelisted props the user can update
function whitelistProps (obs) {
  var newObs = {}
  USER_UPDATABLE_PROPS.forEach(function (prop) {
    newObs[prop] = obs[prop]
  })
  return newObs
}

// All valid top-level props
var TOP_LEVEL_PROPS = USER_UPDATABLE_PROPS.concat([
  'created_at',
  'timestamp',
  'id',
  'version',
  'type'
])

// Props from old versions of mapeo-mobile that we can discard
var SKIP_OLD_PROPS = [
  'created_at_timestamp',
  'link',
  'device_id',
  'observedBy'
]

function transformOldObservation (obs) {
  switch (getSchemaVersion(obs)) {
    case 1:
      return transformObservationSchema1(obs)
    case 2:
      return transformObservationSchema2(obs)
    default:
      return obs
  }
}

// Transform an observation from Sinangoe version of MM to the current format
function transformObservationSchema1 (obs) {
  var newObs = { tags: {} }
  Object.keys(obs).forEach(function (prop) {
    if (prop === 'attachments') {
      // Attachments has changed from array of strings to array of objects
      newObs.attachments = (obs.attachments || []).map(a => {
        if (typeof a !== 'string') return a
        return { id: a }
      })
    } else if (prop === 'fields') {
      // fields.answer should be a tag
      newObs.fields = obs.fields || []
      newObs.fields.forEach(f => {
        if (!f || !f.answer || !f.id) return
        newObs.tags[f.id] = f.answer
      })
    } else if (SKIP_OLD_PROPS.indexOf(prop) > -1) {
      // just ignore unused old props
    } else if (TOP_LEVEL_PROPS.indexOf(prop) > -1) {
      // Copy across valid top-level props
      newObs[prop] = obs[prop]
    } else if (prop === 'created') {
      // created is changed to created_at
      newObs.created_at = obs.created
    } else {
      newObs.tags[prop] = obs[prop]
    }
  })
  return newObs
}

// Transform an observation from ECA version of MM to the current format
function transformObservationSchema2 (obs) {
  var newObs = Object.assign({}, obs, {tags: {}})
  Object.keys(obs.tags || {}).forEach(function (prop) {
    if (prop === 'fields') {
      newObs.fields = obs.tags.fields
    } else if (prop === 'created') newObs.created_at = obs.tags.created
    else newObs.tags[prop] = obs.tags[prop]
  })
  return newObs
}

// Get the schema version of the observation
// Prior to schema 3 we had two beta testing schemas in the wild
// which did not have a schemaVersion property
function getSchemaVersion (obs) {
  if (obs.schemaVersion) return obs.schemaVersion
  if (typeof obs.device_id === 'string' &&
    typeof obs.created === 'string' &&
    typeof obs.tags === 'undefined') return 1
  if (typeof obs.created_at === 'undefined' &&
    typeof obs.tags !== 'undefined' &&
    typeof obs.tags.created === 'string') return 2
  return null
}
