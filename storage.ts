/** ts-check */

import { Env } from './env'

import { triple } from 'rdflib'

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
 Example:
 ```json
	{
        "book": { "type": "uri" , "value": "http://example.org/book/book6" } ,
        "title": { "type": "literal" , "value": "Harry Potter and the Half-Blood Prince" }
	}
 ```
*/
interface Binding {
	  [key: string]: { 
		type: 'uri' | 'bnode' | 'literal', 
		value: string,
		datatype?: string,
		'xml:lang'?: string // IRI
	}
}

type Bindings = Binding[]

export interface Storage {
  /**
   * Initialize the database.
   * @param env - provides the environment parameters
   */
  init(env: Env): Promise<void>

  /**
   * Drop an initialized database.
   */
  drop(): Promise<void>

  /**
   * Reserve a URI for subsequent update.
   * @param uri - The URI to reserve
   */
  reserveURI(uri: string): Promise<void>

  /**
   * Release a reserved URI that is no longer needed.
   * @param uri - The URI to release
   */
  releaseURI(uri: string): Promise<void>

  /**
   * Read a resource given its URI.
   * @param uri - The URI to read/GET
   */
  read(uri: string): Promise<any>

  /**
   * Update a resource.
   * @param resource - The resource content to update (includes its uri)
   */
  update(resource: any): Promise<void>

  /**
   * Insert data into an existing resource.
   * @param data - the triples to insert
   * @param uri - URI of the resource to insert the triples into
   */
  insertData(data: any, uri: string): Promise<void>

  /**
   * Remove or delete a resource given its URI.
   * @param uri - The URI of the resource to remove/delete
   */
  remove(uri: string): Promise<void>

  /**
   * Get the membershipTriples of a DirectContainer given its URI.
   * @param container - the URI of the container whose members are being accessed
   */
  getMembershipTriples(container: string): Promise<Bindings>
}
