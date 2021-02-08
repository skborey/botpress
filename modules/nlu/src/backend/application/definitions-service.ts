import * as sdk from 'botpress/sdk'
import { NLU } from 'botpress/sdk'

import { ScopedDefinitionsRepository } from './infrastructure/definitions-repository'
import { DirtyModelCallback } from './typings'

interface BotDefinition {
  languages: string[]
  seed: number
}

export class ScopedDefinitionsService {
  private _languages: string[]
  private _seed: number

  private _needTrainingWatcher: sdk.ListenHandle
  private _dirtyModelCb!: DirtyModelCallback

  constructor(
    bot: BotDefinition,
    private _engine: NLU.Engine,
    private _ghost: sdk.ScopedGhostService,
    private _nluRepo: ScopedDefinitionsRepository,
    private _modelIdService: typeof sdk.NLU.modelIdService
  ) {
    this._languages = bot.languages
    this._seed = bot.seed
  }

  public async initialize(listener: DirtyModelCallback) {
    this._needTrainingWatcher = this._registerNeedTrainingWatcher()
    this._dirtyModelCb = listener
    return this._scanForDirtyModels()
  }

  public async teardown() {
    this._needTrainingWatcher.remove()
  }

  private async _scanForDirtyModels(): Promise<void> {
    for (const language of this._languages) {
      const needsTraining = await this._isDirty(language)
      if (needsTraining) {
        const modelId = await this.getLatestModelId(language)
        await this._dirtyModelCb(modelId)
      }
    }
  }

  private async _isDirty(language: string): Promise<boolean> {
    const modelId = await this.getLatestModelId(language)
    if (this._engine.hasModel(modelId)) {
      return false
    }
    return true
  }

  public async getLatestModelId(languageCode: string): Promise<NLU.ModelId> {
    const { _engine } = this

    const trainSet = await this.getTrainSet(languageCode)

    const specifications = _engine.getSpecifications()
    return this._modelIdService.makeId({
      ...trainSet,
      specifications
    })
  }

  public async getTrainSet(languageCode: string): Promise<sdk.NLU.TrainingSet> {
    const trainDefinitions = await this._nluRepo.getTrainDefinitions()
    return {
      ...trainDefinitions,
      languageCode,
      seed: this._seed
    }
  }

  private _registerNeedTrainingWatcher = () => {
    return this._ghost.onFileChanged(async filePath => {
      const hasPotentialNLUChange = filePath.includes('/intents/') || filePath.includes('/entities/')
      if (!hasPotentialNLUChange) {
        return
      }
      await Promise.filter(this._languages, this._isDirty)
        .map(this.getLatestModelId)
        .map(this._dirtyModelCb)
    })
  }
}
