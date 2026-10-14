import { zhCNLocale } from '../vendor/lib/i18n/messages/zh-CN';
import { translateMessage } from '../vendor/lib/i18n/format';
export function useI18n() {
  return { locale: 'zh-CN', t: (key: string, params?: any) => translateMessage('zh-CN', key, { 'zh-CN': zhCNLocale.messages }, params) };
}
