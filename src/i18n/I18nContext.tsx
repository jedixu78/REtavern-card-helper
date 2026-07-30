import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type Context,
  type ReactNode,
} from 'react';
import { translations, type Language, getNestedValue } from './translations';

const STORAGE_KEY = 'tavern-card-helper-lang';

function detectDefaultLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && saved in translations) return saved as Language;
  } catch {
    // localStorage unavailable (e.g. SSR or privacy mode)
  }
  return 'zh';
}

export interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, params?: Record<string, string>) => string;
}

// 关键：跨 HMR 复用同一个 Context 对象。
// 本文件 import 了 translations.ts，因此每次编辑翻译文件都会触发本模块 HMR 重执行，
// 默认会创建一个全新的 I18nContext。但 main.tsx 里的 <I18nProvider> 不会随之重渲染，
// 仍持有旧 Context；而热更新后的组件（如 StepCharacters）读到的是新 Context，
// useContext 拿不到 Provider → 返回 null → useTranslation 抛
// "must be used within I18nProvider"，整页白屏。
// 用 import.meta.hot.data 在模块重载间保留同一个 Context 实例即可避免该问题。
const hotData = import.meta.hot?.data as
  | { i18nContext?: Context<I18nContextValue | null> }
  | undefined;

export const I18nContext: Context<I18nContextValue | null> =
  hotData?.i18nContext ?? createContext<I18nContextValue | null>(null);

if (import.meta.hot) {
  import.meta.hot.data.i18nContext = I18nContext;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => detectDefaultLanguage());

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, lang);
  }, [lang]);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string>) => {
      const value = getNestedValue(((translations as unknown as Record<string, unknown>)[lang] ?? translations.zh) as unknown as Record<string, unknown>, key);
      let result = value ?? key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          result = result.replaceAll(`{{${k}}}`, v);
        });
      }
      return result;
    },
    [lang],
  );

  const value = useMemo(
    () => ({ lang, setLang, t }),
    [lang, setLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation must be used within I18nProvider');
  }
  return ctx;
}
