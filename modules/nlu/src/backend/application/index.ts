import { NLU } from 'botpress/sdk'
import _ from 'lodash'

import { BotNotMountedError } from './errors'
import { Bot, BotFactory, Predictor, TrainingQueue } from './typings'

export class NLUApplication {
  private _bots: _.Dictionary<Bot> = {}

  constructor(private _trainingQueue: TrainingQueue, private _engine: NLU.Engine, private _botFactory: BotFactory) {}

  public async initialize() {
    await this._trainingQueue.initialize()
  }

  public teardown = async () => {
    await this._trainingQueue.teardown()

    for (const botId of Object.keys(this._bots)) {
      await this.unmountBot(botId)
    }
  }

  public getHealth() {
    return this._engine.getHealth()
  }

  public async getTraining(botId: string, language: string): Promise<NLU.TrainingSession> {
    return this._trainingQueue.getTraining({ botId, language })
  }

  public hasBot = (botId: string) => {
    return !!this._bots[botId]
  }

  public getBot(botId: string): Predictor {
    const bot = this._bots[botId]
    if (!bot) {
      throw new BotNotMountedError(botId)
    }
    return this._bots[botId]
  }

  public mountBot = async (botId: string) => {
    const needsTrainingCallback = (language: string) => {
      return this._trainingQueue.needsTraining({ botId, language })
    }

    const bot = await this._botFactory.makeBot(botId)
    await bot.mount(needsTrainingCallback)
    this._bots[botId] = bot
  }

  public unmountBot = async (botId: string) => {
    const bot = this._bots[botId]
    if (!bot) {
      throw new BotNotMountedError(botId)
    }

    await this._bots[botId].unmount()
    delete this._bots[botId]
  }

  public async queueTraining(botId: string, language: string) {
    const bot = this._bots[botId]
    if (!bot) {
      throw new BotNotMountedError(botId)
    }
    return this._trainingQueue.queueTraining({ botId, language }, bot)
  }

  public async cancelTraining(botId: string, language: string) {
    const bot = this._bots[botId]
    if (!bot) {
      throw new BotNotMountedError(botId)
    }
    return this._trainingQueue.cancelTraining({ botId, language })
  }
}
