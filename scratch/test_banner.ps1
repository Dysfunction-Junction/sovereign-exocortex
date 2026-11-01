$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.50.129', 22)
$stream = $client.GetStream()
$reader = New-Object System.IO.StreamReader($stream)
$client.ReceiveTimeout = 20000
try {
    $line = $reader.ReadLine()
    Write-Output "BANNER: $line"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
} finally {
    $client.Close()
}
