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

export const ns = 'http://www.w3.org/ns/ldp#'
export const prefix = 'ldp'

// Resources
export const Resource = ns + 'Resource'
export const RDFSource = ns + 'RDFSource'
export const Container = ns + 'Container'
export const BasicContainer = ns + 'BasicContainer'
export const DirectContainer = ns + 'DirectContainer'

// Properties
export const contains = ns + 'contains'
export const membershipResource = ns + 'membershipResource'
export const hasMemberRelation = ns + 'hasMemberRelation'
export const isMemberOfRelation = ns + 'isMemberOfRelation'

// Link relations
export const constrainedBy = ns + 'constrainedBy'

// Preferences
export const PreferContainment = ns + 'PreferContainment'
export const PreferMembership = ns + 'PreferMembership'
export const PreferMinimalContainer = ns + 'PreferMinimalContainer'
export const PreferEmptyContainer = ns + 'PreferEmptyContainer'
