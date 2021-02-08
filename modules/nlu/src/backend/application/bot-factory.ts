import * as sdk from 'botpress/sdk'
import { NLU } from 'botpress/sdk'
import _ from 'lodash'

import { Bot } from './bot'
import { ScopedDefinitionsService } from './definitions-service'
import { BotNotMountedError } from './errors'
import { ScopedDefinitionsRepository } from './infrastructure/definitions-repository'
import { ScopedModelRepository } from './infrastructure/model-repository'
import pickSeed from './pick-seed'
import { BotDefinition, BotFactory as IBotFactory, DirtyModelCallback, NeedsTrainingCallback } from './typings'

export class BotFactory implements IBotFactory {
  constructor(
    private _bp: typeof sdk,
    private _engine: NLU.Engine,
    private _logger: sdk.Logger,
    private _modelIdService: typeof NLU.modelIdService
  ) {}

  async initialize(): Promise<void> {}

  async teardown(): Promise<void> {}

  async makeBot(botId: string): Promise<Bot> {
    const { _engine } = this

    const botConfig = await this._bp.bots.getBotById(botId)
    if (!botConfig) {
      throw new BotNotMountedError(botId)
    }

    const { defaultLanguage } = botConfig
    const languages = _.intersection(botConfig.languages, _engine.getLanguages())
    if (botConfig.languages.length !== languages.length) {
      const missingLangMsg = `Bot ${botId} has configured languages that are not supported by language sources. Configure a before incoming hook to call an external NLU provider for those languages.`
      this._logger.forBot(botId).warn(missingLangMsg, { notSupported: _.difference(botConfig.languages, languages) })
    }

    const botDefinition: BotDefinition = {
      botId,
      defaultLanguage,
      languages,
      seed: pickSeed(botConfig)
    }

    const scopedGhost = this._bp.ghost.forBot(botId)
    const defRepo = new ScopedDefinitionsRepository(botDefinition, this._bp)
    const modelRepo = new ScopedModelRepository(botDefinition, this._modelIdService, scopedGhost)
    const defService = new ScopedDefinitionsService(
      botDefinition,
      this._engine,
      scopedGhost,
      defRepo,
      this._modelIdService
    )

    return new Bot(botDefinition, this._engine, modelRepo, defService, this._modelIdService, this._logger)
  }
}
