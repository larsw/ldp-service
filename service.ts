/*
 * Copyright 2014 IBM Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * service.js is Express middleware that handles HTTP requests for LDP resources.
 * It is built on an abstract storage implementation, storage.js that can be
 * implemented on different data sources to expose them as LDP resources.
 * The internal, in-memory representation of a resource is an rdflib.js
 * IndexedFormula.
 */

import express, { type Express, Request, Response, NextFunction } from 'express'
import rdflib from 'rdflib'
import * as ldp from './vocab/ldp'
import * as rdf from './vocab/rdf'
import * as media from './media'
import crypto from 'node:crypto'
import { Env } from './env'
import { type Storage } from './storage'

// Some convenient namespaces
const RDF = rdflib.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#')
const RDFS = rdflib.Namespace('http://www.w3.org/2000/01/rdf-schema#')
const LDP = rdflib.Namespace('http://www.w3.org/ns/ldp#')

let appBase: string | undefined = undefined
let db: Storage

declare module 'express-serve-static-core' {
  interface Request {
    fullURL?: string
    rawBody?: string
  }
}

/*
 * Middleware to create the full URI for the request for use in
 * storage identifiers.
 */
const fullURL = (req: Request, res: Response, next: NextFunction) => {
  req.fullURL = appBase + req.originalUrl
  next()
}

/*
 * Middleware to create a UTF8 encoded copy of the original request body
 * used in JSON and N3 parsers.
 */
const rawBody = (req: Request, _: Response, next: NextFunction) => {
  req.rawBody = ''
  req.setEncoding('utf8')

  req.on('data', (chunk) => {
    req.rawBody += chunk
  })

  req.on('end', () => {
    next()
  })
}

/*
 * Middleware to handle all LDP requests
 */
const ldpRoutes = (env: Env) => {
  const subApp = express()
  subApp.use(fullURL)
  subApp.use(rawBody)
  const resource = subApp.route(env.context + '*')

  // route any requests matching the LDP context (defaults to /r/*)
  resource.all((_, res: Response, next: NextFunction) => {
    // all responses should have Link: <ldp:Resource> rel=type
    const links: Record<string, string> = {
      type: ldp.Resource,
    }
    // also include implementation constraints
    links[ldp.constrainedBy] = env.appBase + '/constraints.html'
    res.links(links)
    next()
  })

  // Internal function to handle LDP GET and HEAD requests
  const get = async (req: Request, res: Response, includeBody: boolean) => {
    res.set('Vary', 'Accept')
    try {
      const document = await db.read(req.fullURL!)
      addHeaders(req, res, document)

      let serialize
      if (req.accepts(media.turtle)) {
        serialize = media.turtle
      } else if (req.accepts(media.jsonld) || req.accepts(media.json)) {
        serialize = media.jsonld
      } else if (req.accepts(media.rdfxml)) {
        serialize = media.rdfxml
      } else {
        res.sendStatus(406) // Not Acceptable
        return
      }

      const preferenceApplied = await insertCalculatedTriples(req, document)
      const content = await rdflib.serialize(
        document.sym(req.fullURL),
        document,
        'none:',
        serialize
      )

      if (preferenceApplied) {
        res.set('Preference-Applied', 'return=representation')
      }

      const eTag = getETag(content)
      if (req.get('If-None-Match') === eTag) {
        res.sendStatus(304)
        return
      }

      res.writeHead(200, {
        ETag: eTag,
        'Content-Type': serialize,
      })
      if (includeBody) {
        res.end(Buffer.from(content), 'utf-8')
      } else {
        res.end()
      }
    } catch (err) {
      console.error(err)
      res.sendStatus(500)
    }
  }

  resource.get((req, res) => {
    get(req, res, true)
  })

  resource.head((req, res) => {
    get(req, res, false)
  })

  const putUpdate = async (req: Request, res: Response, document: any, newTriples: any, serialize: string) => {
    // LDP servers should not support update of LDPCs
    if (
      document.interactionModel === ldp.BasicContainer ||
      document.interactionModel === ldp.DirectContainer
    ) {
      res.set('Allow', 'GET,HEAD,DELETE,OPTIONS,POST').sendStatus(405)
      return
    }

    const ifMatch = req.get('If-Match')
    if (!ifMatch) {
      res.sendStatus(428)
      return
    }

    const content = await rdflib.serialize(
      document.sym(document.uri),
      document,
      'none:',
      serialize
    )
    const eTag = getETag(content)
    if (ifMatch !== eTag) {
      res.sendStatus(412)
      return
    }

    updateInteractionModel(newTriples)
    await db.update(newTriples)
    res.sendStatus(200)
  }

  const putCreate = async (req: Request, res: Response, document: any) => {
    document.uri = req.fullURL
    updateInteractionModel(document)

    // check if the client requested a specific interaction model through a
    // Link header.  if so, override what we found from the RDF content.
    // FIXME: look for Link type=container as well
    if (hasResourceLink(req)) {
      document.interactionModel = ldp.RDFSource
    }

    // check the membership triple pattern if this is a direct container
    if (!isMembershipPatternValid(document)) {
      res.sendStatus(409)
      return
    }

    await db.update(document)
    res.sendStatus(201)
  }

  /*
   * Imiplements the HTTP PUT method which requests that the enclosed entity be
   * stored under the supplied Request-URI. Uses putUpdate to update an existing
   * resource and putCreate to create a new one.
   */
  resource.put(async (req, res) => {
    let serialize
    if (req.is(media.turtle)) {
      serialize = media.turtle
    } else if (req.is(media.jsonld) || req.is(media.json)) {
      serialize = media.jsonld
    } else {
      res.sendStatus(415)
      return
    }

    const newTriples = new rdflib.IndexedFormula()
    try {
      await rdflib.parse(req.rawBody!, newTriples, req.fullURL!, serialize)
      newTriples.uri = req.fullURL

      try {
        const document = await db.read(req.fullURL!)
        await putUpdate(req, res, document, newTriples, serialize)
      } catch (err) {
        if (err === 404) {
          await putCreate(req, res, newTriples)
        } else {
          res.sendStatus(500)
        }
      }
    } catch (err) {
      console.error(err)
      res.sendStatus(500)
    }
  })

  /*
   * Implements HTTP POST to create new resources and add them to
   * a container.
   */
  resource.post(async (req, res) => {
    try {
      const container = await db.read(req.fullURL!)
      if (!container.interactionModel) {
        res.set('Allow', 'GET,HEAD,PUT,DELETE,OPTIONS').sendStatus(405)
        return
      }

      let serialize
      if (req.is(media.turtle)) {
        serialize = media.turtle
      } else if (req.is(media.jsonld) || req.is(media.json)) {
        serialize = media.jsonld
      } else {
        res.sendStatus(415)
        return
      }

      const loc = await assignURI(req.fullURL!, req.get('Slug'))
      const newMember: rdflib.Formula = new rdflib.IndexedFormula()
      newMember.uri = loc
      await rdflib.parse(req.rawBody!, newMember, loc, serialize)
      updateInteractionModel(newMember)
      addHeaders(req, res, newMember)

      // check if the client requested a specific interaction model through a Link header
      // if so, override what we found from the RDF content
      // TODO: look for Link type=container as well
      if (hasResourceLink(req)) {
        newMember.interactionModel = ldp.RDFSource
      }

      // check the membership triple pattern if the new member is a direct container
      if (!isMembershipPatternValid(newMember)) {
        await db.releaseURI(loc)
        res.sendStatus(409)
        return
      }

      // Add the membership triple required to realize the containment
      if (container.interactionModel === ldp.DirectContainer) {
        if (container.isMemberOfRelation) {
          newMember.add(
            rdflib.sym(loc),
            rdflib.sym(container.isMemberOfRelation),
            rdflib.sym(container.membershipResource)
          )
        } else {
          const data = new rdflib.IndexedFormula()
          data.add(
            rdflib.sym(container.membershipResource),
            rdflib.sym(container.hasMemberRelation),
            rdflib.sym(loc)
          )
          await db.insertData(data, container.membershipResource)
        }
      } else {
        // update the BasicContainer's member
        const data = new rdflib.IndexedFormula()
        data.add(rdflib.sym(req.fullURL!), LDP('contains'), rdflib.sym(loc))
        await db.insertData(data, req.fullURL!)
      }
      // update the membership resource
      await db.update(newMember)
      res.location(loc).sendStatus(201)
    } catch (err) {
      console.error(err)
      res.sendStatus(500)
    }
  })

  resource.delete(async (req, res) => {
    try {
      await db.remove(req.fullURL!)
      res.sendStatus(200)
    } catch (err) {
      res.sendStatus(500)
    }
  })

  resource.options(async (req, res) => {
    try {
      const document = await db.read(req.fullURL!)
      addHeaders(req, res, document)
      res.sendStatus(200)
    } catch (err) {
      console.error(err)
      res.sendStatus(500)
    }
  })

  // generate an ETag for a response using an MD5 hash
  // note: insert any calculated triples before calling getETag()
  const getETag = (content: string | undefined) => {
	if (!content) {
	  return 'W/"0"'
	} else {
		return 'W/"' + crypto.createHash('md5').update(content).digest('hex') + '"'
	}
  }

  // add common headers to all responses
  const addHeaders = (req: Request, res: Response, document: any) => {
    let allow = 'GET,HEAD,DELETE,OPTIONS'
    if (document.interactionModel) {
      res.links({
        type: document.interactionModel,
      })
      allow += ',POST'
      res.set(
        'Accept-Post',
        media.turtle +
          ',' +
          media.jsonld +
          ',' +
          media.json +
          ',' +
          media.rdfxml
      )
    } else {
      allow += ',PUT'
    }

    res.set('Allow', allow)
  }

  // look at the triples to determine the type of container if this is a
  // container and, if a direct container, its membership pattern
  const updateInteractionModel = (document: any) => {
    let interactionModel = ldp.RDFSource

    const uriSym = document.sym(document.uri)
    if (
      document.statementsMatching(uriSym, RDF('type'), ldp.BasicContainer)
        .length !== 0
    )
      interactionModel = ldp.BasicContainer
    if (
      document.statementsMatching(uriSym, RDF('type'), ldp.DirectContainer)
        .length !== 0
    )
      interactionModel = ldp.DirectContainer
    if (interactionModel === ldp.DirectContainer) {
      let statement = document.any(uriSym, ldp.membershipResource)
      if (statement) document.membershipResource = statement.value
      statement = document.any(uriSym, ldp.hasMemberRelation)
      if (statement) document.hasMemberRelation = statement.value
      statement = document.any(uriSym, ldp.isMemberOfRelation)
      if (statement) document.isMemberOfRelation = statement.value
    }

    // don't override an existing interaction model
    if (!document.interactionModel) {
      document.interactionModel = interactionModel
    }
  }

  // determine if this is a membership subApp.  if it is, insert the
  // membership triples.
  const insertMembership = async (req: Request, document: any) => {
    const patterns = document.membershipResourceFor
    if (patterns) {
      if (hasPreferOmit(req, ldp.PreferMembership)) {
        return true
      }

      const preferenceApplied = hasPreferInclude(req, ldp.PreferMembership)
      let inserted = 0
      for (const pattern of patterns) {
        const containment = await db.getMembershipTriples(pattern.container)
        if (containment) {
          for (const resource of containment) {
            document.triples.push({
              subject: document.name,
              predicate: pattern.hasMemberRelation,
              object: resource,
            })
          }
        }
        inserted++
      }
      return preferenceApplied
    }
    return false
  }

  // insert any dynamically calculated triples
  const insertCalculatedTriples = async (req: Request, document: any) => {
    // insert membership if this is a membership resource
    const preferenceApplied = await insertMembership(req, document)
    // all done if this is not a container
    if (document.interactionModel === null) {
      return preferenceApplied
    }

    // next insert any dynamic triples if this is a container

    // check if client is asking for a minimal container
    let minimal = false
    if (
      hasPreferInclude(req, ldp.PreferMinimalContainer) ||
      hasPreferInclude(req, ldp.PreferEmptyContainer)
    ) {
      minimal = true
    }

    // include containment?
    let includeContainment
    if (hasPreferInclude(req, ldp.PreferContainment)) {
      includeContainment = true
    } else if (hasPreferOmit(req, ldp.PreferContainment)) {
      includeContainment = false
    } else {
      includeContainment = !minimal
    }

    // include membership?
    let includeMembership
    if (
      document.interactionModel === ldp.DirectContainer &&
      document.hasMemberRelation
    ) {
      if (hasPreferInclude(req, ldp.PreferMembership)) {
        includeMembership = true
      } else if (hasPreferOmit(req, ldp.PreferMembership)) {
        includeMembership = false
      } else {
        includeMembership = !minimal
      }
    } else {
      includeMembership = false
    }

    if (!includeContainment && !includeMembership) {
      // we're done!
      return preferenceApplied
    }
    const members = await db.getMembershipTriples(document)
    if (members) {
      for (const member of members) {
        if (includeContainment) {
          document.add(
            document.sym(document.uri),
            ldp.contains,
            document.sym(member.member.value),
            document.sym(document.uri)
          )
        }

        if (includeMembership) {
          document.add(
            document.sym(document.membershipResource),
            document.sym(document.hasMemberRelation),
            document.sym(member.member.value),
            document.sym(document.uri)
          )
        }
      }
    }

    return preferenceApplied
  }

  // append 'path' to the end of a uri
  // - any query or hash in the uri is removed
  // - any special characters like / and ? in 'path' are replaced
  const addPath = (uri: string, path: string) => {
    uri = uri.split('?')[0].split('#')[0]
    if (uri.substr(-1) !== '/') {
      uri += '/'
    }

    // remove special characters from the string (e.g., '/', '..', '?')
    const lastSegment = path.replace(/[^\w\s\-_]/gi, '')
    return uri + encodeURIComponent(lastSegment)
  }

  // generates and reserves a unique URI with base URI 'container'
  const uniqueURI = async (container: string) => {
    const candidate = addPath(container, 'res' + Date.now())
    await db.reserveURI(candidate)
    return candidate
  }

  // reserves a unique URI for a new resource. will use slug if available,
  // but falls back to the usual naming scheme if slug is already used
  const assignURI = async (container: string, slug?: string) => {
    if (slug) {
      const candidate = addPath(container, slug)
      try {
        await db.reserveURI(candidate)
        return candidate
      } catch {
        return await uniqueURI(container)
      }
    } else {
      return await uniqueURI(container)
    }
  }

  // removes any membership triples from a membership resource before updating
  // it in the database
  // membership triples are not stored with the resource itself but are
  // calculated based on the Prefer header
  const removeMembership = (document: any) => {
    if (document.membershipResourceFor) {
      // find the member relations. handle the case where the resource is
      // a membership resource for more than one container.
      const memberRelations: Record<string, number> = {}
      document.membershipResourceFor.forEach((memberPattern: any) => {
        if (memberPattern.hasMemberRelation) {
          memberRelations[memberPattern.hasMemberRelation] = 1
        }
      })

      // now filter the triples
      document.triples = document.triples.filter((triple: any) => {
        // keep the triple if the subject is not the membership
        // resource or the predicate is not one of the member relations
        return (
          triple.subject !== document.name || !memberRelations[triple.predicate]
        )
      })
    }
  }

  // look for a Link request header indicating the entity uses a ldp:Resource
  // interaction model rather than container
  const hasResourceLink = (req: Request) => {
    const link = req.get('Link')
    // look for links like
    //	 <http://www.w3.org/ns/ldp#Resource>; rel="type"
    // these are also valid
    //	 <http://www.w3.org/ns/ldp#Resource>;rel=type
    //	 <http://www.w3.org/ns/ldp#Resource>; rel="type http://example.net/relation/other"
    return (
      link &&
      /<http:\/\/www\.w3\.org\/ns\/ldp#Resource\>\s*;\s*rel\s*=\s*(("\s*([^"]+\s+)*type(\s+[^"]+)*\s*")|\s*type[\s,;$])/.test(
        link
      )
    )
  }

  const hasPreferInclude = (req: Request, inclusion: string) => {
    return hasPrefer(req, 'include', inclusion)
  }

  const hasPreferOmit = (req: Request, omission: string) => {
    return hasPrefer(req, 'omit', omission)
  }

  const hasPrefer = (req: Request, token: string, parameter: string) => {
    if (!req) {
      return false
    }

    const preferHeader = req.get('Prefer')
    if (!preferHeader) {
      return false
    }

    // from the LDP prefer parameters, the only charcter we need to escape
    // for regular expressions is '.'
    // https://dvcs.w3.org/hg/ldpwg/raw-file/default/ldp.html#prefer-parameters
    const word = parameter.replace(/\./g, '\\.')

    // construct a regex that matches the preference
    const regex = new RegExp(
      token +
        '\\s*=\\s*("\\s*([^"]+\\s+)*' +
        word +
        '(\\s+[^"]+)*\\s*"|' +
        word +
        '$)'
    )
    return regex.test(preferHeader)
  }

  // check the consistency of the membership triple pattern if this is a direct container
  const isMembershipPatternValid = (document: any) => {
    if (document.interactionModel !== ldp.DirectContainer) {
      // not a direct container, nothing to do
      return true
    }

    // must have a membership resouce
    if (!document.membershipResource) {
      return false
    }

    // must have hasMemberRelation or isMemberOfRelation, but can't have both
    if (document.hasMemberRelation) {
      return !document.isMemberOfRelation
    }
    if (document.isMemberOfRelation) {
      return !document.hasMemberRelation
    }

    // no membership triple pattern
    return false
  }
  return subApp
}

export default async (env: Env): Promise<Express> => {
  appBase = env.appBase
  db = env.storageService
  await db.init(env).catch((err) => {
    console.error(err)
    console.error("Can't initialize the database.")
    throw err
  })
  return ldpRoutes(env)
}
