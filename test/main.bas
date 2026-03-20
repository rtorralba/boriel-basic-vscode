#include "lib/functions.bas"

Print "Hello, World!"
Print "Hello, Pepe!"
Print "Hello, Luis!"

greetings()

Dim score As Ubyte
score = 85

If score < 90 Then
    greetUser("Maria")
Else
    Print "Hello, Jose!"
End If

Print "Hello, Antonio!"

Sub greetUser(name As String)
    Print "Hello, " + name + "!"
End Sub

