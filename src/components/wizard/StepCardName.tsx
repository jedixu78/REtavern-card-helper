/**
 * Step 1: Card Name + Tags.
 * Card name is the only field that cannot be AI-generated.
 * Tags are for frontend sorting/filtering (not used in AI prompts).
 */
import { TextInput } from '../shared/TextInput';
import { TagInput } from '../shared/TagInput';
import { StepHeader } from '../shared/StepHeader';
import { useTranslation } from '../../i18n/I18nContext';

interface StepCardNameProps {
  cardName: string;
  tags: string[];
  onNameChange: (name: string) => void;
  onTagsChange: (tags: string[]) => void;
}

export function StepCardName({ cardName, tags, onNameChange, onTagsChange }: StepCardNameProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <div>
        <StepHeader title={t('cardName.title')} subtitle={t('cardName.description')} />
        <TextInput
          label={t('cardName.nameLabel')}
          value={cardName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('cardName.namePlaceholder')}
          autoFocus
        />
      </div>

      <div className="border-t border-[color-mix(in_srgb,var(--text-color)_5%,transparent)] pt-6">
        <h3 className="text-lg font-semibold text-themed mb-2">{t('cardName.tagsTitle')}</h3>
        <p className="text-xs text-themed-muted mb-2">
          {t('cardName.tagsDesc')}
        </p>
        <TagInput
          tags={tags}
          onChange={onTagsChange}
          placeholder={t('cardName.tagsPlaceholder')}
        />
      </div>
    </div>
  );
}
