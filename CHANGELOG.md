# Change Log

All notable changes to the "copilot-token-tracker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- Intelligent file caching to improve performance when processing session files
- Cache management with automatic size limits and cleanup of non-existent files
- Cache hit/miss rate logging for performance monitoring

### Changed  
- Session file processing now uses cached data when files haven't been modified
- Reduced file I/O operations during periodic updates for better performance

- Initial release