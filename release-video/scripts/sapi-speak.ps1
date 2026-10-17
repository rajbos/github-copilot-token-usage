<#
.SYNOPSIS
	Speaks a text file to a WAV using the Windows built-in speech synthesizer.

.DESCRIPTION
	The zero-install fallback voice for the release-video pipeline. It exists so
	the whole pipeline can be run end to end — script, screenshots, timing,
	subtitles, render — before any TTS model has been downloaded, which makes
	the cloned voice a swap rather than a prerequisite.

	The narration arrives as a *file path*, never as a command-line string, so
	nothing in a release note can be re-parsed as PowerShell.

.PARAMETER TextFile
	UTF-8 file holding exactly the text to speak.

.PARAMETER OutFile
	WAV file to write. Overwritten if it exists.

.PARAMETER VoiceName
	Installed voice to select. Empty uses the system default.
	List them with:  .\sapi-speak.ps1 -ListVoices

.PARAMETER Rate
	Speaking rate, -10 (slowest) to 10 (fastest). 0 is normal.
#>
[CmdletBinding()]
param(
	[string] $TextFile,
	[string] $OutFile,
	[string] $VoiceName = '',
	[ValidateRange(-10, 10)]
	[int] $Rate = 0,
	[switch] $ListVoices
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

try {
	if ($ListVoices) {
		$synth.GetInstalledVoices() |
			Where-Object { $_.Enabled } |
			ForEach-Object { $_.VoiceInfo } |
			Select-Object Name, Culture, Gender, Age |
			Format-Table -AutoSize
		return
	}

	if (-not $TextFile) { throw 'TextFile is required.' }
	if (-not $OutFile) { throw 'OutFile is required.' }
	if (-not (Test-Path -LiteralPath $TextFile)) { throw "No such text file: $TextFile" }

	if ($VoiceName) {
		$available = $synth.GetInstalledVoices() |
			Where-Object { $_.Enabled } |
			ForEach-Object { $_.VoiceInfo.Name }
		if ($available -notcontains $VoiceName) {
			throw "Voice '$VoiceName' is not installed. Available: $($available -join ', ')"
		}
		$synth.SelectVoice($VoiceName)
	}

	$synth.Rate = $Rate

	$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
	if ([string]::IsNullOrWhiteSpace($text)) { throw "Text file is empty: $TextFile" }

	$parent = Split-Path -Parent $OutFile
	if ($parent -and -not (Test-Path -LiteralPath $parent)) {
		New-Item -ItemType Directory -Path $parent -Force | Out-Null
	}

	$synth.SetOutputToWaveFile($OutFile)
	$synth.Speak($text)
}
finally {
	# Releases the wave file handle; without this the WAV stays locked and
	# ffprobe reads a zero-length file on the very next step.
	$synth.SetOutputToNull()
	$synth.Dispose()
}
