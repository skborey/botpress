import * as sdk from 'botpress/sdk'
import _ from 'lodash'
import LRU from 'lru-cache'
import ms from 'ms'

import { Config } from '../config'
import { MODULE_NAME } from '../constants'

import { StateType } from './index'
import { IAgent, IHandoff } from './../types'
import { extendAgentSession, measure } from './helpers'
import Repository from './repository'
import Socket from './socket'

const debug = DEBUG(MODULE_NAME)

const registerMiddleware = async (bp: typeof sdk, state: StateType) => {
  const handoffCache = new LRU<string, string>({ max: 1000, maxAge: ms('1 day') })
  const agentCache = <Omit<IAgent, 'online'>>{}
  const repository = new Repository(bp, state.timeouts)
  const realtime = Socket(bp)

  const pipeEvent = async (event: sdk.IO.IncomingEvent, eventDestination: sdk.IO.EventDestination) => {
    debug.forBot(event.botId, 'Piping event', eventDestination)
    return bp.events.replyToEvent(eventDestination, [{ type: 'typing', value: 10 }, event.payload])
  }

  const handoffCacheKey = (botId: string, threadId: string) => [botId, threadId].join('.')

  const getCachedHandoff = (botId: string, threadId: string) => {
    return handoffCache.get(handoffCacheKey(botId, threadId))
  }

  const getCachedAgent = (agentId: string) => {
    return agentCache[agentId]
  }

  const cacheHandoff = (botId: string, threadId: string, handoff: IHandoff) => {
    debug.forBot(botId, 'Caching handoff', { id: handoff.id, threadId })
    handoffCache.set(handoffCacheKey(botId, threadId), handoff.id)
  }

  const cacheAgent = (agentId: string, agent: IAgent) => {
    debug('Caching agent', { id: agent.agentId })
    agentCache[agentId] = agent
  }

  const expireHandoff = (botId: string, threadId: string) => {
    debug.forBot(botId, 'Expiring handoff', { threadId })
    handoffCache.del(handoffCacheKey(botId, threadId))
  }

  const handleIncomingFromUser = async (handoff: IHandoff, event: sdk.IO.IncomingEvent) => {
    if (handoff.status === 'assigned') {
      // There only is an agentId & agentThreadId after assignation
      await pipeEvent(event, {
        botId: handoff.botId,
        target: handoff.agentId,
        threadId: handoff.agentThreadId,
        channel: handoff.userChannel
      })
    }

    // At this moment the event isn't persisted yet so an approximate
    // representation is built and sent to the frontend, which relies on
    // this to update the handoff's preview and read status.
    const partialEvent = {
      event: _.pick(event, ['preview']),
      success: undefined,
      threadId: undefined,
      ..._.pick(event, ['id', 'direction', 'botId', 'channel', 'createdOn', 'threadId'])
    }

    realtime.sendPayload(event.botId, {
      resource: 'handoff',
      type: 'update',
      id: handoff.id,
      payload: {
        ...handoff,
        userConversation: partialEvent
      }
    })

    realtime.sendPayload(event.botId, {
      resource: 'event',
      type: 'create',
      id: null,
      payload: partialEvent
    })
  }

  const handleIncomingFromAgent = async (handoff: IHandoff, event: sdk.IO.IncomingEvent) => {
    const { botAvatarUrl }: Config = await bp.config.getModuleConfigForBot(MODULE_NAME, event.botId)
    const { attributes } = getCachedAgent(handoff.agentId)

    Object.assign(event.payload, {
      from: 'agent',
      botAvatarUrl: botAvatarUrl || attributes?.picture_url
    })

    await pipeEvent(event, {
      botId: handoff.botId,
      threadId: handoff.userThreadId,
      target: handoff.userId,
      channel: handoff.userChannel
    })

    await extendAgentSession(repository, realtime, event.botId, handoff.agentId)
  }

  const incomingHandler = async (event: sdk.IO.IncomingEvent, next: sdk.IO.MiddlewareNextCallback) => {
    // TODO we might want to handle other types
    if (event.type !== 'text') {
      return next(undefined, false, true)
    }

    const handoffId = getCachedHandoff(event.botId, event.threadId)

    if (!handoffId) {
      next(undefined, false)
      return
    }

    const handoff = await repository.getHandoff(handoffId)

    const incomingFromUser = handoff.userThreadId === event.threadId
    const incomingFromAgent = handoff.agentThreadId === event.threadId

    if (incomingFromUser) {
      debug.forBot(event.botId, 'Handling message from User', { direction: event.direction, threadId: event.threadId })
      await handleIncomingFromUser(handoff, event)
    } else if (incomingFromAgent) {
      debug.forBot(event.botId, 'Handling message from Agent', { direction: event.direction, threadId: event.threadId })
      await handleIncomingFromAgent(handoff, event)
    }

    // the session or bot is paused, swallow the message
    // TODO deprecate usage of isPause
    // @ts-ignore
    Object.assign(event, { isPause: true, handoffId: handoff.id })

    next()
  }

  // Performance: Eager load and cache handoffs that will be required on every incoming message.
  // - Only 'active' handoffs are cached because they are the only ones for which the middleware
  // handles agent <-> user event piping
  // - Handoffs must be accessible both via their respective agent thread ID and user thread ID
  // for two-way message piping
  const warmup = async () => {
    const agents = repository.listAllAgents().then((agents: IAgent[]) => {
      agents.forEach(agent => {
        cacheAgent(agent.agentId, agent)
      })
    })

    const handoffs = repository.listActiveHandoffs().then((handoffs: IHandoff[]) => {
      handoffs.forEach(handoff => {
        handoff.agentThreadId && cacheHandoff(handoff.botId, handoff.agentThreadId, handoff)
        handoff.userThreadId && cacheHandoff(handoff.botId, handoff.userThreadId, handoff)
      })
    })

    return Promise.all([agents, handoffs])
  }

  if (debug.enabled) {
    await measure('cache-warmup', warmup(), items => {
      items.getEntries().forEach(entry => {
        debug('performance', _.pick(entry, 'name', 'duration'))
      })
    })
  } else {
    await warmup()
  }

  state.cacheHandoff = await bp.distributed.broadcast(cacheHandoff)
  state.expireHandoff = await bp.distributed.broadcast(expireHandoff)

  bp.events.registerMiddleware({
    name: 'hitlnext.incoming',
    direction: 'incoming',
    order: 0,
    description: 'Handles message-passing between users and agents',
    handler: incomingHandler
  })
}

const unregisterMiddleware = async (bp: typeof sdk) => {
  bp.events.removeMiddleware('hitlnext.incoming')
}

export { registerMiddleware, unregisterMiddleware }
