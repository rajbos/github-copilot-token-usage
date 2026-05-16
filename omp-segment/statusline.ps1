$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

function Format-TokenCount {
    param([Nullable[double]]$Value)
    if ($null -eq $Value) { return '?' }
    if ($Value -ge 1000000000) { return ('{0:0.0}b' -f ($Value / 1000000000)) }
    if ($Value -ge 1000000) { return ('{0:0.0}m' -f ($Value / 1000000)) }
    if ($Value -ge 1000) { return ('{0:0.0}k' -f ($Value / 1000)) }
    return ([int]$Value).ToString()
}

function Format-Duration {
    param([Nullable[double]]$Milliseconds)
    if ($null -eq $Milliseconds -or $Milliseconds -le 0) { return '00:00:00' }
    $duration = [TimeSpan]::FromMilliseconds($Milliseconds)
    return '{0:00}:{1:00}:{2:00}' -f [int]$duration.TotalHours, $duration.Minutes, $duration.Seconds
}

function New-Gauge {
    param([Nullable[double]]$Percent)
    if ($null -eq $Percent) { return '..........' }
    $bounded = [Math]::Max(0, [Math]::Min(100, [Math]::Round($Percent)))
    $filled = [int][Math]::Floor($bounded / 10)
    return ('#' * $filled) + ('.' * (10 - $filled))
}

$payload = [Console]::In.ReadToEnd()

try {
    $json = $payload | ConvertFrom-Json
} catch {
    Write-Host -NoNewline 'Copilot status unavailable'
    exit 0
}

$context = $json.context_window
$cost    = $json.cost

$currentTokens = if ($null -ne $context.current_context_tokens)       { [double]$context.current_context_tokens }       else { $null }
$contextLimit  = if ($null -ne $context.displayed_context_limit)       { [double]$context.displayed_context_limit }       else { $null }
$contextPercent = if ($null -ne $context.current_context_used_percentage) {
    [double]$context.current_context_used_percentage
} elseif ($null -ne $context.used_percentage) {
    [double]$context.used_percentage
} else {
    $null
}

$linesAdded   = if ($null -ne $cost.total_lines_added)   { [int]$cost.total_lines_added }   else { 0 }
$linesRemoved = if ($null -ne $cost.total_lines_removed) { [int]$cost.total_lines_removed } else { 0 }

$env:COPILOT_STATUS_CONTEXT  = "$(Format-TokenCount $currentTokens)/$(Format-TokenCount $contextLimit)"
$env:COPILOT_STATUS_GAUGE    = New-Gauge $contextPercent
$env:COPILOT_STATUS_DURATION = Format-Duration $cost.total_duration_ms
$env:COPILOT_STATUS_CHANGES  = if ($linesAdded -or $linesRemoved) { "+$linesAdded/-$linesRemoved" } else { '' }

# Add total daily / 30-day token usage (cached via ai-engineering-fluency's own segment cache)
try {
    $tokenOutput = & ai-engineering-fluency segment 2>$null
    $env:COPILOT_TOKEN_USAGE = if ($tokenOutput) { $tokenOutput.Trim() } else { '' }
} catch {
    $env:COPILOT_TOKEN_USAGE = ''
}

$theme = Join-Path $PSScriptRoot 'statusline.omp.json'
$cwd   = if ($json.cwd) { [string]$json.cwd } else { (Get-Location).Path }

try {
    $output = & oh-my-posh print primary --config $theme --pwd $cwd --force --escape=false 2>$null
    if ([string]::IsNullOrWhiteSpace($output)) { throw 'Oh My Posh returned no output.' }
    Write-Host -NoNewline $output.TrimEnd()
} catch {
    # Plain-text fallback when oh-my-posh is unavailable
    $changes = if ($env:COPILOT_STATUS_CHANGES) { " | $($env:COPILOT_STATUS_CHANGES)" } else { '' }
    $tokens  = if ($env:COPILOT_TOKEN_USAGE)    { " | $($env:COPILOT_TOKEN_USAGE)" }    else { '' }
    Write-Host -NoNewline "ctx $($env:COPILOT_STATUS_CONTEXT) $($env:COPILOT_STATUS_GAUGE) | $($env:COPILOT_STATUS_DURATION)$changes$tokens"
}
