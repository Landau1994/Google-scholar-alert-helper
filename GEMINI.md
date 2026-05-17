# ScholarPulse Project Conventions & Developer Habits

## Documentation & Changelog
- **Changelog Updates**: Always update the `README.md` Changelog section immediately after adding new features, making significant improvements, or fixing bugs.
- **Changelog Format**: Use the date format `### YYYY-MM-DD` for the header.
- **Entry Format**: Use specific bold prefixes for list items to categorize changes. Examples:
  - `- **Added**: [Description]`
  - `- **Fixed**: [Description]`
  - `- **Improved**: [Description]`
  - `- **Changed**: [Description]`

## Git Workflow
- **Auto-Commit & Push**: After completely implementing and verifying a feature or fix (including the Changelog update), automatically stage the affected files, commit them with a descriptive message, and push the changes to the remote repository (`origin main`), unless explicitly instructed otherwise.

## UI/UX & Robustness
- **Graceful Fallbacks**: Always provide robust error handling and fallback mechanisms for modern browser APIs. For example, if `navigator.clipboard` is unavailable in HTTP environments, implement a `document.execCommand('copy')` fallback or manual prompt.
- **State Feedback**: Always handle and display `isLoading`, `error`, and empty states explicitly in UI components to ensure good user experience.
