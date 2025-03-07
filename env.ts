import { Storage } from './storage'

export interface Env {
	appBase?: string
	context?: string
	storageService: Storage
}
