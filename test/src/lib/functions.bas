Sub checkScoreAndPrint()
    If score > hiScore Then
        hiScore = score
        Print "New Hi-Score!"
    Else
        Print "Score: " + Str(score)
    End If
End Sub