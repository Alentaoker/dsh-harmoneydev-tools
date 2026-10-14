import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void { try { windowStage.loadContent('pages/Index'); } catch (_) { /* fixture */ } }
}
