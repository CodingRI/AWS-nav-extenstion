import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import type { OpenRouterModel } from "@aws-nav/shared";

interface ModelSelectorProps {
  models: OpenRouterModel[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  emptyMessage?: string;
}

export function ModelSelector({
  models,
  selectedModelId,
  onSelect,
  disabled = false,
  emptyMessage = "No models match your search.",
}: ModelSelectorProps) {
  const [query, setQuery] = useState("");

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return models;
    }

    return models.filter((model) => {
      const searchableText = `${model.name} ${model.id} ${model.provider}`.toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [models, query]);

  return (
    <div className="aws-nav-model-selector">
      <label className="aws-nav-field-label" htmlFor="aws-nav-model-search">
        Choose model
      </label>
      <div className="aws-nav-search-input-wrapper">
        <Search size={14} />
        <input
          id="aws-nav-model-search"
          type="text"
          className="aws-nav-search-input"
          placeholder="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
        />
      </div>

      <div className="aws-nav-model-list" role="listbox" aria-label="OpenRouter models">
        {filteredModels.length === 0 && (
          <div className="aws-nav-empty-state">{emptyMessage}</div>
        )}

        {filteredModels.map((model) => {
          const isSelected = model.id === selectedModelId;

          return (
            <button
              key={model.id}
              type="button"
              className={`aws-nav-model-option ${isSelected ? "selected" : ""}`}
              onClick={() => onSelect(model.id)}
              disabled={disabled}
            >
              <div className="aws-nav-model-option-main">
                <div className="aws-nav-model-option-title">{model.name}</div>
                <div className="aws-nav-model-option-meta">
                  <span>{model.provider}</span>
                  <span>{model.id}</span>
                </div>
                {model.description && (
                  <div className="aws-nav-model-option-description">
                    {model.description}
                  </div>
                )}
              </div>

              {isSelected && (
                <span className="aws-nav-model-option-check" aria-hidden="true">
                  <Check size={14} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
