$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$BackupDir = Join-Path $Root 'backups'

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$UploadsPath = Join-Path $Root 'uploads'
if (Test-Path $UploadsPath) {
    $zipPath = Join-Path $BackupDir "uploads-$Timestamp.zip"
    Compress-Archive -Path $UploadsPath -DestinationPath $zipPath -Force
}

$dbPath = Join-Path $BackupDir "db-$Timestamp.sql"
& docker exec arena-messenger-postgres pg_dump -U messenger messenger | Out-File -Encoding utf8 $dbPath

Write-Host "Backup created in $BackupDir"
